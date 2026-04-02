Gemini 说
🎬 Segment Queue Runner

The Segment Queue Runner (SQR) is a specialized automation node designed for the ComfyUI Wan Animate workflow. It enables the generation of long videos by splitting tasks into manageable segments, ensuring seamless transitions while preventing system memory or VRAM exhaustion.
🚀 Key Features

    🔧 Segmented Generation: Automatically divides long videos into multiple parts to avoid system crashes due to high memory or VRAM usage.

    🔗 Seamless Connections: Each segment automatically utilizes the end frames of the previous segment as a transition to maintain motion continuity.

    ⏩ Automatic Transitions: Supports multiple reference images to achieve automatic costume changes or scene transitions across different segments.

    💾 Breakpoint Resume: Features an automatic progress tracking system that allows users to resume generation from the last completed segment if interrupted.

    🎬 Automated Merging: Uses FFmpeg to automatically concatenate all segments into a final video output.

    🎵 Audio Alignment: Automatically extracts and aligns audio from the reference video by calculating frame offsets based on the frame rate.

🛠 Installation
1. Clone the Repository

Navigate to your ComfyUI/custom_nodes directory and run the following command:
Bash

git clone https://github.com/FX-FeiHou/comfyui_segment_queue_runner.git

2. Requirements

    FFmpeg: This node requires FFmpeg to be installed on your system and added to your PATH environment variable, or the ffmpeg.exe file must be placed in the ComfyUI root directory.

    Workflow Compatibility: Specifically designed for the Wan Animate KJ Context workflow.

⚙️ Core Parameters
Mandatory Inputs

    Total Frames: Must be connected to the frame_count output of the Load Video node.

    Frame Rate: Must be connected to the fps output of the Load Video node to ensure proper audio synchronization.

Segment Settings

    Segment Count: Defines how many parts the video will be split into (Range: 2–20).

    Start From Segment: Sets the starting segment index, typically set to 1 for new projects.

    Execution: A toggle to switch between Preview Mode (False) and Generation Mode (True).

    Enable Resume: Used in conjunction with Resume Video Selection to continue from a specific interrupted segment.

📐 Technical Logic
Cropping Rules ✂️

To ensure invisible transitions at the stitching points, the node automatically crops the segments as follows:

    First Segment: Does not crop the beginning; crops the final 16 frames.

    Middle Segments: Crops both the first 16 frames and the last 16 frames.

    Last Segment: Crops the first 16 frames; does not crop the end.

📖 Usage Modes

    Preview Mode (Execution = False) 📋: Displays the segmentation plan, including frame ranges and estimated duration, via a text display node.

    New Generation (Execution = True) 🚀: Generates all segments from the first index and merges them automatically upon completion.

    Resume Mode (Enable Resume = True) ⏩: Allows continuation after a failure by selecting the last successful segment and setting the starting index to the next segment.

⚖️ Copyright & Credits

Segment Queue Runner Developed by: FeiHou & XueZi.

All rights reserved. Material retention is supported for further utilization.
