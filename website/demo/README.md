# Chanh UI demo assets

The 1:57 narrated walkthrough of the **real Chanh extension** — not the mockup. It was recorded against a live local Lemonade Server and a real VS Code window.

**[Poster frame](Chanh-Demo-Poster.png)**

> The MP4 is intentionally excluded from the repository and will be published on YouTube. The website uses the poster as a placeholder until then. Do not force-add `Chanh-UI-Demo.mp4`.

## What it covers

| Time | Feature |
| --- | --- |
| 0:00 | Title and overview |
| 0:05 | Chanh sidebar with real server and code workspace |
| 0:16 | Server health, local URL, version, backends, CPU/GPU/RAM |
| 0:28 | Loaded, installed and downloadable model groups |
| 0:38 | Model actions: hover actions and the capability tooltip |
| 0:50 | Right-click menu: context size, reset, remove |
| 0:58 | Switching the active Lemonade server |
| 1:06 | Model Info panel |
| 1:17 | Context-size quick pick |
| 1:25 | Backend quick pick (CPU / CUDA / Vulkan) |
| 1:35 | Command palette |
| 1:44 | Chanh settings |

Chat is intentionally omitted, per the requested scope. Every image in the video comes from the extension's actual UI.

## Recording details

- VS Code 1.142.0 with Chanh 0.1.3
- Lemonade Server 11.8.1, local on `http://localhost:13305`, with 21 installed models
- Qwen3.5-4B-MTP-GGUF loaded for the Model Info scene
- Captured from an isolated VS Code profile, then zoomed and captioned in post
- 1920×1080, 30 fps, H.264 + AAC, neural voiceover and burned-in captions

When the video is on YouTube, set `YOUTUBE_URL` in [`../site.js`](../site.js) to activate both play buttons on the site.
