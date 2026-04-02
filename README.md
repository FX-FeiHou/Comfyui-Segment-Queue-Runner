🎬 ComfyUI Segment Queue Runner

Developed by: FX-FeiHou FeiHou & XueZi 

The Segment Queue Runner is a powerful automation node designed for the ComfyUI Wan Animate workflow. It solves the problem of "VRAM/RAM out of memory" during long video generation by automatically splitting videos into segments, processing them with seamless transitions, and merging them into a final masterpiece.
🌟 Key Features

    🚀 Turbo Segmentation: Automatically splits long videos into multiple segments to prevent memory crashes.

    🔗 Seamless Transitions: Each segment reads the end of the previous one to maintain motion continuity.

    🎭 Dynamic Turnaround: Supports multiple reference images for automatic character or scene transitions.

    ⚡ Breakpoint Recovery: Automatically records progress, allowing you to resume from where you left off.

    🎞️ One-Click Merge: Uses ffmpeg to automatically concatenate segments and sync audio.

    🎵 Smart Audio Sync: Automatically extracts and offsets audio from the reference video.

📥 Installation 
Option 1: ComfyUI-Manager (Recommended)

    Open ComfyUI-Manager.

    Click "Install Custom Nodes".

    Search for Segment Queue Runner.

    Click Install and restart ComfyUI.

Option 2: Manual Installation (Git)
Bash

cd ComfyUI/custom_nodes/
git clone https://github.com/FX-FeiHou/Comfyui-Segment-Queue-Runner.git
cd Comfyui-Segment-Queue-Runner
pip install -r requirements.txt

Note: Ensure FFmpeg is installed and added to your system's PATH for the merging feature to work.

⚙️ Parameters
Parameter	Icon	Description
Total Frames	🔢	

Input from Load Video frame_count.
Frame Rate	⏱️	

Input from Load Video fps for audio alignment.
Segments	✂️	

Number of parts (2–20) based on your VRAM limits.
Start From	🚩	

1 for new projects; specific ID for resuming.
Execute	🔘	

OFF for Preview (Check logs); ON for production.
Enable Resume	⏯️	

Uses a selected video clip as the starting transition.

📖 Usage Guide
Step 1: Setup & Binding 🔗

    Connect frame_count and fps from your Load Video node.

    Click "Set Node ID" (设置节点ID) buttons on the UI to bind the Load Video, Video Combine, and WanAnimateEmbeds nodes by clicking them in your workspace.

Step 2: Preview Mode 🔍

    Set Execute to OFF.

    Adjust Segments so each part fits your VRAM (e.g., 150-200 frames).

    Run the prompt to view the segmentation plan in the logs or ShowText node.

Step 3: Customization & Execution 🚀

    (Optional) Click "Select Segment Images" (选择分段参考图) to assign unique styles per segment.

    Switch Execute to ON and run.

    The node will sequentially process segments and merge the final video into your output folder.

🛠️ Breakpoint Recovery ⏩

If generation is interrupted:

    Identify the last completed segment from the console.

    Set "Start From Segment" to the next segment ID.

    Click "Resume Video Selection" and pick the last successful video.

    Set "Enable Resume" to ON and Execute to ON, then run.

⚖️ License & Credits

    Developed by: FX-FeiHou FX-FeiHou FeiHou & XueZi 

    Special Thanks: wuwukaka (for transition_video logic) and Kijai (for base wrapper maintenance).

    License: This project is licensed under the MIT License. Free for personal and commercial use; please provide attribution to the original authors.
