"""Run the exported ONNX node through an ORT Extensions Python callback."""

import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from onnxruntime_extensions import (
    PyCustomOpDef,
    enable_py_op,
    get_library_path,
    onnx_op,
)

from kernel import launch_rms_norm


@onnx_op(
    op_type="TritonRMSNorm",
    inputs=[PyCustomOpDef.dt_float, PyCustomOpDef.dt_float],
    outputs=[PyCustomOpDef.dt_float],
    attrs={"epsilon": PyCustomOpDef.dt_float},
)
def ort_rms_norm(x_np, weight_np, epsilon):
    # ORT passes CPU NumPy arrays to this Python callback.
    with torch.inference_mode():
        x = torch.from_numpy(np.ascontiguousarray(x_np)).to("cuda:0")
        weight = torch.from_numpy(
            np.ascontiguousarray(weight_np)
        ).to("cuda:0")
        y = launch_rms_norm(x, weight, epsilon)
        # This copy also waits for the GPU result before returning to ORT.
        return y.cpu().numpy()


def run_model(model_path):
    if not torch.cuda.is_available():
        raise RuntimeError("This example requires CUDA-enabled PyTorch")

    enable_py_op(True)
    options = ort.SessionOptions()
    options.register_custom_ops_library(get_library_path())

    session = ort.InferenceSession(
        str(model_path),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )

    rng = np.random.default_rng(0)
    x_np = rng.standard_normal((2, 256)).astype(np.float32)
    weight_np = rng.standard_normal(256).astype(np.float32)
    y_ort = session.run(["y"], {"x": x_np, "weight": weight_np})[0]

    with torch.inference_mode():
        x = torch.from_numpy(x_np).to("cuda:0")
        weight = torch.from_numpy(weight_np).to("cuda:0")
        reference = (
            x * torch.rsqrt((x * x).mean(dim=-1, keepdim=True) + 1e-5)
        ) * weight
        y_triton = launch_rms_norm(x, weight, 1e-5)
        torch.testing.assert_close(
            y_triton, reference, rtol=1e-4, atol=1e-5
        )
        reference_np = reference.cpu().numpy()

    np.testing.assert_allclose(
        y_ort, reference_np, rtol=1e-4, atol=1e-5
    )
    print("Triton and ORT results match the PyTorch reference")
    print("Max absolute error:", float(np.max(np.abs(y_ort - reference_np))))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model", type=Path, default=Path("triton_rms_norm.onnx")
    )
    run_model(parser.parse_args().model)
