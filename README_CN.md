# ComfyUI Segment Queue Runner（分段队列节点）

[English](sslocal://flow/file_open?url=README.md&flow_extra=eyJsaW5rX3R5cGUiOiJjb2RlX2ludGVycHJldGVyIn0=)

专为 ComfyUI Wan Animate / KJ Context 设计的长视频自动化生成节点，实现分段生成、无缝衔接、自动转场、断点续跑、自动合并、音频对齐，解决长视频生成显存不足、衔接断层、中断需重跑等问题。

## ✨ 核心功能
- 分段生成：自动拆分长视频，根据显存大小灵活设置分段数，彻底解决显存/内存不足报错
- 无缝衔接：每段生成时自动读取上一段末尾帧作为起始帧，动作连贯不跳变、不卡顿
- 自动转场：支持多参考图分段切换，轻松实现风格、角色、换装等自然转场效果
- 断点续跑：生成中断（如断电、闪退）后，可从指定段落继续生成，不重复渲染已完成部分
- 自动合并：所有分段生成完成后，自动拼接成完整视频，无需手动操作
- 音频自动对齐：自动提取原视频音频，生成后与最终视频精准对齐，无需额外剪辑
- 分段计划预览：生成前可预览分段详情，确认无误后再执行，避免浪费时间和资源

## 📦 安装方法
打开 ComfyUI/custom_nodes 文件夹，运行以下命令：
cd ComfyUI/custom_nodes

git clone https://github.com/FX-FeiHou/Comfyui-Segment-Queue-Runner.git

## 🚀 快速使用
1. 将 Load Video（加载视频）节点的 frame_count（总帧数）和 fps（帧率），连接到本节点
2. 设置分段数（建议 2-20，根据自身 GPU 显存大小调整），关闭「执行」按钮，先预览分段计划
3. 通过本节点上的按钮，绑定以下3个必需节点：
   - 参考视频节点（Load Video）
   - 视频输出节点（VHS_VideoCombine）
   - 动作嵌入节点（WanVideoAnimateEmbeds）
4. 确认绑定无误、分段计划合理后，开启「执行」按钮，开始全自动生成

## 🛠 三种模式说明
- 预览模式：关闭「执行」，仅显示分段计划（每段帧数、起始结束帧），不进行渲染，快速确认分段是否合理
- 全新生成：从第1段开始逐段渲染，全部完成后自动合并成完整视频，适用于首次生成
- 续跑模式：生成中断后使用，设置起始分段，选择上一次中断时的最后一段视频，启用「续跑」，即可无缝继续生成

## 📌 常见问题（FAQ）
- 提示「节点ID为空」：未绑定必需节点，点击本节点上的对应按钮，绑定 Load Video、VHS_VideoCombine、WanVideoAnimateEmbeds 三个节点即可
- 生成中断后如何续跑：设置「从第几段开始」→ 选择上一次生成的最后一段视频 → 启用「续跑」→ 开启「执行」
- 最终视频保存路径：ComfyUI 的 output 文件夹下，文件名以 sqr_merged_ 开头（如 sqr_merged_20240520.mp4）
- 提示「ffmpeg missing」：未安装 ffmpeg 或未添加到系统 PATH，安装 ffmpeg 后配置环境变量即可正常使用

## 👥 作者
肥猴 & 雪子

## 📄 许可证
MIT License
