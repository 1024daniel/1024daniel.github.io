"""Export a PyTorch custom op to an opaque ONNX node; no ORT import."""

import argparse
from pathlib import Path

import onnx
import onnxscript
import torch
from onnxscript import FLOAT

from kernel import launch_rms_norm, validate_inputs


@torch.library.custom_op(
    "ort_demo::triton_rms_norm",
    mutates_args=(),
    device_types="cuda",
)
def triton_rms_norm(
    x: torch.Tensor,
    weight: torch.Tensor,
    epsilon: float,
) -> torch.Tensor:
    return launch_rms_norm(x, weight, epsilon)


@triton_rms_norm.register_fake
def triton_rms_norm_fake(x, weight, epsilon):
    validate_inputs(x, weight, epsilon)
    # The real kernel also returns a fresh contiguous tensor.
    return x.new_empty(x.shape)


class Model(torch.nn.Module):
    def forward(self, x, weight):
        return triton_rms_norm(x, weight, 1e-5)


custom = onnxscript.values.Opset(domain="ai.onnx.contrib", version=1)


@onnxscript.script(custom)
def export_rms_norm(
    x: FLOAT, weight: FLOAT, epsilon: float,
) -> FLOAT:
    return custom.TritonRMSNorm(x, weight, epsilon=epsilon)


def export_model(output):
    if not torch.cuda.is_available():
        raise RuntimeError("This example requires CUDA-enabled PyTorch")

    torch.manual_seed(0)
    x = torch.randn(2, 256, device="cuda:0", dtype=torch.float32)
    weight = torch.randn(256, device="cuda:0", dtype=torch.float32)
    output.parent.mkdir(parents=True, exist_ok=True)

    torch.onnx.export(
        Model().eval(),
        args=(x, weight),
        f=str(output),
        dynamo=True,
        opset_version=18,
        input_names=["x", "weight"],
        output_names=["y"],
        custom_translation_table={
            torch.ops.ort_demo.triton_rms_norm.default: export_rms_norm,
        },
        optimize=False,
        external_data=False,
        verify=False,
    )

    model = onnx.load(str(output))
    onnx.checker.check_model(model)
    nodes = list(model.graph.node)
    for function in model.functions:
        nodes.extend(function.node)
    if not any(
        node.domain == "ai.onnx.contrib"
        and node.op_type == "TritonRMSNorm"
        for node in nodes
    ):
        raise RuntimeError("The exported model has no TritonRMSNorm node")

    print("Saved:", output)
    print("Opsets:", [(entry.domain, entry.version)
                      for entry in model.opset_import])
    print("Nodes:", [(node.domain, node.op_type) for node in nodes])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=Path("triton_rms_norm.onnx")
    )
    export_model(parser.parse_args().output)
