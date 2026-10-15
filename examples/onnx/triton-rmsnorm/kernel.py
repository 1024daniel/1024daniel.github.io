"""Shared float32 RMSNorm kernel for PyTorch and the ORT Python callback."""

import math

import torch
import triton
import triton.language as tl


def validate_inputs(x, weight, epsilon):
    """Check metadata only, so the same checks can run on FakeTensor."""
    if x.dtype != torch.float32 or weight.dtype != torch.float32:
        raise ValueError("RMSNorm requires float32 inputs")
    if x.ndim != 2 or weight.ndim != 1:
        raise ValueError("RMSNorm requires x[M,H] and weight[H]")
    # This small teaching kernel intentionally limits the row width.
    torch._check(x.shape[1] > 0)
    torch._check(x.shape[1] <= 4096)
    torch._check(weight.shape[0] == x.shape[1])
    if x.device != weight.device:
        raise ValueError("Inputs must be on the same device")
    if not math.isfinite(epsilon) or epsilon <= 0:
        raise ValueError("epsilon must be finite and positive")


@triton.jit
def rms_norm_kernel(
    X, W, Y,
    H: tl.constexpr,
    EPS: tl.constexpr,
    BLOCK: tl.constexpr,
):
    row = tl.program_id(0)
    col = tl.arange(0, BLOCK)
    mask = col < H

    x = tl.load(X + row * H + col, mask=mask, other=0.0)
    w = tl.load(W + col, mask=mask, other=0.0)
    mean_square = tl.sum(x * x, axis=0) / H
    y = x * tl.rsqrt(mean_square + EPS) * w

    tl.store(Y + row * H + col, y, mask=mask)


def launch_rms_norm(x, weight, epsilon):
    validate_inputs(x, weight, epsilon)
    if not x.is_cuda:
        raise ValueError("The Triton kernel requires CUDA inputs")

    x = x.contiguous()
    weight = weight.contiguous()
    y = x.new_empty(x.shape)
    rows, hidden = x.shape

    if rows > 0:
        with torch.cuda.device(x.device):
            rms_norm_kernel[(rows,)](
                x, weight, y,
                H=hidden,
                EPS=epsilon,
                BLOCK=triton.next_power_of_2(hidden),
                num_warps=4,
            )
    return y
