# Triton RMSNorm → ONNX → ONNX Runtime

这是 ONNX 基础文章中**路径三：自定义节点与后端实现**的案例。ONNX 保存 `ai.onnx.contrib::TritonRMSNorm` 调用；ORT Extensions 的 Python 回调负责把 NumPy 输入复制到 CUDA，调用共享 Triton 内核，再把结果复制回 CPU。

本例是 Python 回调接入，适合理解与验证流程。它具有 CPU↔GPU 拷贝、Python 调度和首次 Triton JIT 编译开销；没有注册原生 CUDAExecutionProvider 内核。

## 文件

- `kernel.py`：共享 Triton RMSNorm 内核、输入约束与启动函数。
- `export_model.py`：PyTorch custom_op、register_fake、ONNX 翻译与导出。
- `run_ort.py`：ORT Extensions Python 回调、Session 注册与数值对照。
- `requirements.txt`：除 PyTorch/Triton 外的 Python 依赖。

## 环境

使用具有 NVIDIA GPU 的 Linux/WSL，先安装适配驱动的 CUDA 版 PyTorch，以及与该 PyTorch 兼容的 Triton。导出接口要求 PyTorch >= 2.6。不要为了此例随意替换 PyTorch 已安装的 Triton 版本。

确认：

~~~bash
python -c "import torch, triton; print(torch.__version__, triton.__version__); assert torch.cuda.is_available()"
python -m pip install -r requirements.txt
~~~

requirements.txt 没有锁定版本，具体组合仍需验证。当前仓库交付环境缺少 PyTorch、Triton、ORT 和可用的 GPU 验证工具；这里只完成静态代码及文章构建检查，尚未实测 GPU 导出与推理。

本例用 CPU 版 onnxruntime 即可，因为 ORT 调度的是 CPU 接口的 Python 回调；CUDA 计算由回调中的 PyTorch/Triton 发起。

## 执行

在本目录运行，示例输出放在临时目录：

~~~bash
python export_model.py --output /tmp/onnx-triton-rmsnorm/model.onnx
python run_ort.py --model /tmp/onnx-triton-rmsnorm/model.onnx
~~~

运行脚本还需要能从同目录导入 kernel.py。如果从文章下载，请把三个 .py 文件放在同一目录。

export_model.py 不导入 ORT，也不执行真实 Triton 内核；它需要 CUDA 示例张量，利用 fake 实现捕获图，并把 target 翻译成 ONNX 自定义节点。它会检查主图与函数体中是否包含该节点。

run_ort.py 在创建 Session 前执行 @onnx_op 注册和 register_custom_ops_library；它不需要导入 export_model.py。导出器里的 custom_translation_table 不参与 ORT 执行。

推理通过后，脚本会打印：

~~~text
Triton and ORT results match the PyTorch reference
Max absolute error: <本次运行得到的误差>
~~~

这是预期成功输出，实际数值以运行结果为准。数值对照覆盖本例固定输入，不等同于完整边界条件或性能测试。

## 接口与限制

- ONNX 图有两个输入：x[2,256] 与 weight[256]，均为 float32；epsilon 固定为属性 1e-5。
- 内核支持二维 x[M,H]、一维 weight[H]，要求 1 <= H <= 4096；输出为连续张量。导出模型没有启用动态形状。
- 只示范推理，未注册 autograd。
- ORT 回调固定使用 cuda:0，接收并返回 CPU NumPy 数组。
- @onnx_op 的 Python 回调使用 Extensions 的 ai.onnx.contrib 域；TritonRMSNorm 是本例自定义的名称。
- Python 回调和内核源码不会被自动打包进 ONNX，运行进程必须加载相应代码及依赖。
- 改成 CUDAExecutionProvider 不会把 Python 回调变成原生 CUDA 算子。
- 真正的原生 GPU 接入需要另行实现 ORT CUDA custom op：接收设备指针、输出缓冲区和 ORT CUDA stream，启动已编译的 Triton 内核，并匹配节点的 domain、op_type、类型和属性。

## 参考

- [PyTorch 导出器扩展](https://docs.pytorch.org/tutorials/beginner/onnx/onnx_registry_tutorial.html)
- [ORT Extensions Python 自定义算子](https://onnxruntime.ai/docs/extensions/add-op.html)
- [ORT Extensions 官方测试](https://github.com/microsoft/onnxruntime-extensions/blob/main/test/test_pyops.py)
- [ORT CUDA 自定义算子](https://onnxruntime.ai/docs/reference/operators/add-custom-op.html#custom-ops-for-cuda-and-rocm)
- [Triton AOT 编译工具](https://github.com/triton-lang/triton/blob/main/python/triton/tools/compile.py)
