# Chanh demo — Playwright automation

Drives the 8 capture assets for the Chanh demo (production doc: `chanh-demo.md`, kept with the project files) with Playwright
instead of a mouse agent: deterministic locators, explicit pacing, and
waits on real UI state. Recording is built in too — no OBS: each video
scene is captured through Chromium's own screencast and saved as its
own MP4.

## Hybrid mode (`hybrid.js`) — you perform, it stage-manages

If the full automation misbehaves on your machine, run `node hybrid.js`
instead. It does everything except the UI steps: same blank profile,
workspace files, scene order and filenames; it launches VS Code, then
for each scene prints numbered instructions (and the model to use) and
handles the capture — recording starts/stops on your Enter for video
scenes, and screenshots are grabbed at your Enter. `node hybrid.js
--list` prints all instructions without launching. `demo.js` remains
the automated path and doubles as a test harness.

## How it works

- Playwright launches your installed VS Code as an **Extension
  Development Host** for the vscode-chanh repo (`--extensionDevelopmentPath`),
  so the 0.1.4 dev build is what gets demoed — no F5, no Marketplace build.
- It uses a **fresh `--user-data-dir`** inside demo-workspace
  (`.vscode-user-data`): the blank profile. Default theme/zoom/Chanh
  settings are pre-written by the script, and because the `lemond`
  binary lives in the extension's globalStorage inside that dir, the
  binary starts *not installed* — exactly what Scene 2 needs. The dir
  is wiped each run unless `--keep-state` is passed.
- The Lemonade **server state is machine-level** (downloaded models,
  catalog), so it survives the profile wipe. Prepare it once, in any
  profile: chat model + tool-calling model downloaded, one small model
  left not downloaded.
- **Recording is built in.** Each video scene starts/stops a Chromium
  screencast of the window (frames arrive with timestamps whenever the
  pixels change) and encodes it to that scene's MP4 with an ffmpeg
  binary the script resolves itself (system PATH, or a one-time
  download into `bin/`). Keep the VS Code window
  visible and on top during the run. `timeline.json` still logs scene
  start/end marks as a render reference. The 3 screenshots are saved
  directly as PNGs.
- The demo profile sets `chanh.lemondPort` to **10000** (ports 8000 and
  9000 are both unusable on Lan's machine). When Scene 2 is omitted,
  discovery tries this port, then the system server on **13305**, and
  configures the profile to use the server that answered. Runs with
  Scene 2 always use the managed server on **10000**.

## Setup (once)

Requires **Node.js 18+** (the script uses the built-in `fetch` API).

Put this folder **inside your vscode-chanh repo** (so it sits at
`vscode-chanh/chanh-demo-automation/`), open PowerShell in it, and:

```powershell
npm install        # Playwright library only — does not download a browser or FFmpeg
```

That's it — **no configuration**. The script finds everything itself:

- **VS Code** — checks the standard install locations.
- **The repo** — from the script's own location (its parent folder).
- **The models** — it asks the Lemonade server what's downloaded and
  picks: first tool-calling model → Scene 9, first chat model →
  Scenes 3/6/7, smallest not-downloaded chat model → Scene 4.
- **The `lemond` binary** — if one is already installed, the script
  deletes it before Scene 2, so the download always happens on camera.

If an auto-pick chooses wrong on your machine, each value can be forced
with an env var: `DEMO_CODE_PATH`, `DEMO_CHANH_REPO`, `DEMO_WORKSPACE`,
`DEMO_CHAT_MODEL`, `DEMO_TOOL_MODEL`, `DEMO_DOWNLOAD_MODEL` (the model
ones are substrings of the ids shown in the Chanh sidebar).

## Run

```powershell
node demo.js           # all scenes in canonical order (s2 s3 s4 s6 s7 s8 s9 s5)
node demo.js s7 --keep-state # rerun a single failed scene with the existing profile
node demo.js --keep-open   # flag: leave VS Code open at the end
```

Scene 7 installs the managed binary if needed and starts the server before
selecting a model, so it can run from a clean profile. If discovery selected
an existing system server, Scene 7 uses that server. Other single-scene
reruns require an already running server on **10000** or **13305**.
`--keep-state` reuses the VS Code profile.

Exit code is 0 only if every requested scene succeeded. A failed scene
saves `debug-<scene>.png` (what the screen looked like at the failure)
and the run continues unless `--stop-on-error` is passed.

## Outputs (all in demo-workspace)

- `s2-install.mp4`, `s4-download.mp4`, `s5-sysmon.mp4`, `s7-fix.mp4`,
  `s9-agent.mp4` — the video scenes, recorded by the script itself
- `s3-tree.png`, `s6-modelinfo.png`, `s8-slash.png` — the screenshots
- `timeline.json` — scene start/end marks (render reference)
- `main.js`, `helpers.js` — the demo project (created by the script)
- `debug-*.png` — failure evidence (the screen at a failed step), when present

## Calibration warning

First run on a new machine is a calibration run. VS Code's workbench
DOM shifts between versions; if a scene fails, its error names the step
and `debug-<scene>.png` shows the actual screen. The likeliest spots to
need selector tweaks are the chat model picker and the mode dropdown in
Scene 9 and the suggest widget in Scenes 7/8. Fix the locator in
`demo.js`, rerun just that scene.
