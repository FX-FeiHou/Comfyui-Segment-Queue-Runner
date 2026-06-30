# ComfyUI Segment Queue Runner

[🇨🇳 中文说明 (Chinese Version)](./README_CN.md)

A powerful ComfyUI custom node tailored for high-performance AI video generation, long video stitching, and rhythmic outfit-changing workflows. It offers precise segment control, smooth transition rendering, and automated queue execution.

---

### 🚨 What's New in V3.6 (Changelog)
* Compatible with old workflows, no errors even if parameters are blank.
* Auto-detect total frames and FPS, no manual input required.
* Auto fill default values when loading or saving workflows to avoid runtime issues.
* Node controls will not misalign after switching ComfyUI tabs.
* Interruption reminders are displayed next to resume button for neat layout.
* Reminders disappear after turning off resume, users can start new tasks normally.
* Clear breakpoints cache automatically when closing resume to prevent data conflicts.
* New progress cleanup function to remove leftover error and interruption hints.

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
