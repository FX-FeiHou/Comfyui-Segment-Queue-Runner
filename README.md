# ComfyUI Segment Queue Runner

[🇨🇳 中文说明 (Chinese Version)](./README_CN.md)

A powerful ComfyUI custom node tailored for high-performance AI video generation, long video stitching, and rhythmic outfit-changing workflows. It offers precise segment control, smooth transition rendering, and automated queue execution.

---

### 🚨 What's New in V3.0 (Changelog)
* **Perfect Alignment**: Fully compatible with the [ComfyUI-WanAnimatePlus](https://github.com/wuwukaka/ComfyUI-WanAnimatePlus) framework; discontinued support for the legacy WanVideoWrapper framework.
* **3 Advanced Segmentation Modes**:
  1. **Average**: Automatically divides your total frame count into equal segments.
  2. **Manual**: Features a custom visual timeline interface (video track layout) with a live **Video Preview** for frame-perfect beat-matching.
  3. **Fixed Frames**: Splits the video into segments based on a precise, user-defined fixed frame count.
* **Smart Video Stitching (No Quality Loss)**: Fixed the re-encoding bug. Segments are now **merged directly and instantly** if their FPS and time bases match perfectly, skipping unnecessary rendering time.
* **Local Video References**: Supports passing pre-computed local skeleton/pose and facial reference videos directly via Node ID mapping. This eliminates redundant asset capturing when reusing identical choreography or dance loops.
* **Robust Queue Controls**: Fully adapts auto-resume and continuous queue mechanics across all 3 segmentation modes.
* 🐱 **Hidden Easter Egg**: Added a little fun surprise for you to discover!

---

### 💡 Core Features (Legacy Retained)
* **Automated Long Video Stitching**: Solves the VRAM limitation for ultra-long AI video rendering by breaking tasks into manageable segments and stitching them back seamlessly.
* **Smooth Character Outfit Change**: Specialized logic designed for seamless clothing/style transitions across different queue stages without sudden cuts or visual pops.
* **Smart Queue Management**: Prevents ComfyUI from idling. Automatically triggers and sequences the next generation block based on predefined logical checkpoints.

---

### 📦 Installation
1. Go to your ComfyUI directory: `ComfyUI/custom_nodes/`
2. Clone this repository:
   git clone https://github.com/FX-FeiHou/Comfyui-Segment-Queue-Runner.git
3. Install dependencies:
   pip install -r requirements.txt
4. Restart ComfyUI and hard refresh your browser (`Ctrl + F5`).

---

### 👥 Contributors
* **FeiHou** & **wuwukaka** & **XueZi**