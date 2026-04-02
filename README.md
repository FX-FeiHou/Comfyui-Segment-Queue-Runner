# ComfyUI Segment Queue Runner

[中文说明 / 简体中文](sslocal://flow/file_open?url=README_CN.md&flow_extra=eyJsaW5rX3R5cGUiOiJjb2RlX2ludGVycHJldGVyIn0=)

An automated long-video generation node for ComfyUI Wan Animate / KJ Context, supporting segmented generation, seamless transitions, auto scene switching, breakpoint resuming, auto merging, and audio sync.

## ✨ Key Features
- Segmented Generation: Automatically split long videos to avoid out-of-memory errors
- Seamless Transitions: Use last frame of previous segment for smooth continuity
- Auto Scene Switch: Support multi-reference images for style/character changes
- Breakpoint Resume: Continue from any segment after interruption
- Auto Merge: Automatically combine clips into a complete video
- Audio Sync: Auto-extract and align audio from source video
- Preview Mode: Check segment plan before rendering

## 📦 Installation
cd ComfyUI/custom_nodes
git clone https://github.com/FX-FeiHou/Comfyui-Segment-Queue-Runner.git

## 🚀 Quick Start
1. Connect frame_count and fps from Load Video to this node
2. Set segment count, turn off Run to preview the plan first
3. Bind nodes via buttons:
   - Source Video Node (Load Video)
   - Output Node (VHS_VideoCombine)
   - Motion Embedding Node (WanVideoAnimateEmbeds)
4. Turn on Run to start automatic generation

## 🛠 Modes
- Preview: Show segment plan only, no rendering
- New Generation: Render from segment 1 and auto-merge
- Resume: Continue from interrupted video seamlessly

## 📌 FAQ
- Node ID empty: Bind required nodes using the on-node buttons
- Resume after interruption: Set start segment → select last video → enable resume → run
- Output path: output/sqr_merged_xxx.mp4
- ffmpeg missing: Install ffmpeg and add to system PATH

## 👥 Authors
FX-FeiHou

## 📄 License
MIT License
