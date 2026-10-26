/**
 * Chanh demo — Playwright driver for the 8 capture assets in chanh-demo.md.
 *
 * Playwright launches local real VS Code (Electron) as an Extension
 * Development Host for the vscode-chanh repo, with a fresh --user-data-dir
 * (the "blank profile": no settings, no other extensions, and — because
 * the lemond binary lives in the extension's globalStorage inside that
 * dir — no binary installed, which is what Scene 2 needs). It then
 * performs each scene with explicit pacing and waits, and records each
 * video scene itself — no OBS: the window is captured through Chromium's
 * built-in screencast (CDP Page.startScreencast) and the frames are
 * encoded to a per-scene MP4 with an ffmpeg binary the script resolves
 * itself (system PATH, or a one-time download into ./bin). Screenshots
 * are saved directly by Playwright. timeline.json still logs scene
 * start/end marks as a render reference.
 *
 * Run:  node demo.js              — all scenes, canonical order
 *       node demo.js s7 s9        — only those scenes (order normalized)
 *
 * Flags: --keep-open    leave VS Code open at the end
 *        --keep-state   reuse .vscode-user-data instead of wiping it
 *        --stop-on-error  abort the run at the first failed scene
 *
 * Nothing to configure in the normal case: the script auto-detects the
 * VS Code install, the repo (put this folder inside the vscode-chanh
 * repo), and the models (it asks the Lemonade server what's downloaded).
 * Every value can still be overridden with an env var:
 *   DEMO_CODE_PATH      Code.exe path
 *   DEMO_CHANH_REPO     path to the vscode-chanh checkout
 *   DEMO_WORKSPACE      demo-workspace folder (default: ~/demo-workspace)
 *   DEMO_CHAT_MODEL     substring of the chat model id, e.g. "Qwen2.5-Coder"
 *   DEMO_TOOL_MODEL     substring of the tool-calling model id
 *   DEMO_DOWNLOAD_MODEL substring of the small NOT-downloaded model id
 */
'use strict';

const { _electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const env = process.env;
const WORKSPACE = env.DEMO_WORKSPACE || path.join(os.homedir(), 'demo-workspace');
const CONFIG = {
  codePath: env.DEMO_CODE_PATH || '', // auto-detected in preflight
  chanhRepo: env.DEMO_CHANH_REPO || '', // auto-detected in preflight
  workspace: WORKSPACE,
  userData: path.join(WORKSPACE, '.vscode-user-data'),
  chatModel: env.DEMO_CHAT_MODEL || '',
  toolModel: env.DEMO_TOOL_MODEL || '',
  downloadModel: env.DEMO_DOWNLOAD_MODEL || '',
};

const ARGS = process.argv.slice(2);
const FLAGS = new Set(ARGS.filter((a) => a.startsWith('--')));
const CANONICAL = ['s2', 's3', 's4', 's6', 's7', 's8', 's9', 's5'];
const requested = ARGS.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());
const unknown = requested.filter((s) => s !== 'probe' && !CANONICAL.includes(s));
if (unknown.length > 0) {
  console.error(`Unknown scene names: ${unknown.join(', ')}. Valid options: ${[...CANONICAL, 'probe'].join(', ')}`);
  process.exit(1);
}
const SCENES = CANONICAL.filter((s) => requested.length === 0 || requested.includes(s));

// The demo project files, created by the script so the workspace is exact.
const MAIN_JS = `// main.js — demo file: greet() crashes when user is null
function greet(user) {
  return 'Hello, ' + user.name.toUpperCase() + '!';
}

function main() {
  const user = null; // oops: nothing to greet
  console.log(greet(user));
}

main();
`;
const HELPERS_JS = `// helpers.js
function formatName(name) {
  return name.trim().toLowerCase();
}

module.exports = { formatName };
`;

// Settings for the blank profile: demo look + the two Chanh settings.
const SETTINGS = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'window.zoomLevel': 0, // normal scale
  'editor.minimap.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'chanh.showTokenStats': true,
  'chanh.serverMode': 'LEMOND',
  'chanh.lemondPort': 10000, // 8000 and 9000 are both unusable on Lan's machine
};

let app = null;
let win = null;
let t0 = null;
const timeline = [];
const results = [];

const now = () => (t0 ? (Date.now() - t0) / 1000 : 0);
const log = (...a) => console.log(...a);
const W = (ms) => win.waitForTimeout(ms);

function mark(scene, event) {
  const entry = { scene, event, t: Math.round(now() * 10) / 10 };
  timeline.push(entry);
  log(`  [${entry.t.toFixed(1)}s] ${scene} ${event}`);
  writeTimeline();
}

function writeTimeline() {
  try {
    fs.writeFileSync(
      path.join(CONFIG.workspace, 'timeline.json'),
      JSON.stringify({ recordedAt: new Date().toISOString(), marks: timeline }, null, 2)
    );
  } catch { /* workspace may not exist yet during preflight */ }
}

// ---------------------------------------------------------------------------
// Generic workbench helpers. Selectors target aria labels / visible text so
// they survive VS Code point releases better than class chains, with
// fallbacks where the DOM varies between versions.
// ---------------------------------------------------------------------------

const CHAT_INPUT =
  '.chat-widget div[contenteditable="true"], .interactive-session div[contenteditable="true"]';
const CHAT_STOP =
  '.chat-widget [aria-label*="Stop Request"], .chat-widget [aria-label*="Stop"], ' +
  '.interactive-session [aria-label*="Stop"]';
const QUICK_INPUT = '.quick-input-box input';
const QUICK_ROW = '.quick-input-list .monaco-list-row';

async function palette(commandTitle) {
  await win.keyboard.press('F1');
  const input = win.locator(QUICK_INPUT);
  await waitVisible(input, 'the command palette');
  await input.pressSequentially(commandTitle, { delay: 25 });
  await W(500);
  const row = win.locator(QUICK_ROW, { hasText: commandTitle }).first();
  if (await row.isVisible().catch(() => false)) await row.click();
  else await win.keyboard.press('Enter');
  await W(800);
}

async function openChanhSidebar() {
  const btn = win.locator('.activitybar a.action-label[aria-label="Chanh"]').first();
  await waitVisible(btn, 'the Chanh activity-bar button');
  await btn.click();
  // One probe only: sections may legitimately be absent (server stopped),
  // and every scene polls for what it needs — startup never blocks on them.
  await win.locator('.sidebar .monaco-list-row', { hasText: 'Installed Models' })
    .first().isVisible().catch(() => false);
  await W(600);
}

/** Find a sidebar tree row by text, polling while scrolling the
 *  (virtualized) tree so off-screen rows render into the DOM. Returns
 *  the first match that is actually visible — the tree recycles row
 *  elements, so the first DOM match can be a parked spare that never
 *  reports visible while its twin is on screen. */
async function treeRow(text) {
  const rows = win.locator('.sidebar .monaco-list-row', { hasText: text });
  let found = null;
  // Guard against an infinite hang: if we've scrolled to the bottom of the
  // tree without ever seeing a matching row, give up with a clear error.
  let lastScrollTop = -1;
  let stuckPolls = 0;
  await pollUntil(async () => {
    // A view with no provider renders a placeholder and zero rows. The
    // scroll-bottom guard below can never arm in that state (max scroll is 0),
    // so surface the actual cause instead of polling until the run is killed.
    const placeholder = await win
      .locator('.sidebar', { hasText: 'no data provider registered' })
      .count().catch(() => 0);
    if (placeholder > 0) {
      throw new Error(
        `the Chanh sidebar has no data provider (VS Code's "no data provider registered" placeholder) — reload the window, re-open the view, then re-run ${text}`);
    }
    const n = await rows.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      if (await rows.nth(i).isVisible().catch(() => false)) {
        found = rows.nth(i);
        return true;
      }
    }
    // Nudge the tree to virtualize more rows into the DOM. Scroll the
    // treeview element directly (reliable regardless of where the mouse
    // happens to be), then also move the mouse over the tree and wheel
    // as a fallback for VS Code builds where the list isn't the scroller.
    const tree = win.locator('.sidebar .monaco-list').first();
    const box = await tree.boundingBox().catch(() => null);
    if (box) {
      const st = await tree.evaluate((el) => {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollTop + 500, el.scrollHeight - el.clientHeight);
        return { before, after: el.scrollTop, max: el.scrollHeight - el.clientHeight };
      }).catch(() => ({ before: 0, after: 0, max: 0 }));
      if (st.after === lastScrollTop) stuckPolls++;
      else stuckPolls = 0;
      lastScrollTop = st.after;
      if (st.max > 0 && st.after >= st.max && stuckPolls >= 2) {
        throw new Error(`tree row "${text}" not found in the sidebar tree (scrolled to bottom)`);
      }
      await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await win.mouse.wheel(0, 500).catch(() => {});
    }
    return false;
  }, `tree row "${text}"`, 120000);
  return found;
}

/**
 * Is a tree row with this text actually on screen? Any-match visibility
 * (same recycling trap as treeRow), with a ground-truth fallback: an
 * element whose text names it and that has real on-screen rects.
 */
async function anyRowVisible(text) {
  const rows = win.locator('.sidebar .monaco-list-row', { hasText: text });
  const n = await rows.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    if (await rows.nth(i).isVisible().catch(() => false)) return true;
  }
  return win.evaluate((t) => {
    return [...document.querySelectorAll('.monaco-list-row')]
      .some((el) => (el.textContent || '').includes(t) && el.getClientRects().length > 0);
  }, text).catch(() => false);
}

async function expandSection(name) {
  const row = await treeRow(name);
  const expanded = await row.getAttribute('aria-expanded').catch(() => null);
  if (expanded === 'false') {
    const twistie = row.locator('.monaco-tl-twistie').first();
    if (await twistie.isVisible().catch(() => false)) await twistie.click();
    else await row.click({ position: { x: 10, y: 10 } });
    await W(500);
  }
  return row;
}

/** Hover a tree row and click one of its inline action buttons by title. */
async function rowInlineAction(rowText, actionTitle) {
  const row = await treeRow(rowText);
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.hover();
  await W(400);
  const btn = row.locator(`.actions a.action-label[title="${actionTitle}"]`).first();
  await waitVisible(btn, `the "${actionTitle}" action`);
  await btn.click();
  await W(600);
}

async function openFileQuick(name) {
  await win.keyboard.press('Control+P');
  const input = win.locator(QUICK_INPUT);
  await waitVisible(input, 'the quick-open input');
  await input.pressSequentially(name, { delay: 30 });
  await W(500);
  await win.keyboard.press('Enter');
  await W(800);
}

async function openChat() {
  const input = win.locator(CHAT_INPUT).first();
  if (await input.isVisible().catch(() => false)) return input;
  const titleBtn = win.locator('[aria-label*="Open Chat"]').first();
  if (await titleBtn.isVisible().catch(() => false)) await titleBtn.click();
  else await win.keyboard.press('Control+Alt+I');
  await waitVisible(input, 'the chat input');
  return input;
}

async function chatTypeSlow(text, delay = 120) {
  const input = await openChat();
  await input.click();
  await input.pressSequentially(text, { delay });
}

/** Pick a suggestion-widget entry (participant mention / slash command). */
async function pickSuggestion(text) {
  const row = win.locator('.suggest-widget .monaco-list-row', { hasText: text }).first();
  await waitVisible(row, `the "${text}" suggestion`);
  await W(500); // a readable beat on the open menu
  await row.click();
  await W(500);
}

/**
 * Wait for a chat turn to finish: the stop button appears while generating
 * and disappears at the end. While waiting, auto-click any agent-mode
 * approval buttons (Allow / Continue) so tool calls don't stall the take.
 */
async function waitChatIdle() {
  const stop = win.locator(CHAT_STOP).first();
  let seenGenerating = false;
  let hiddenStreak = 0;
  await pollUntil(async () => {
    const approve = win.locator(
      '.chat-widget button:has-text("Allow"), .chat-widget button:has-text("Continue"), ' +
      '.chat-widget .monaco-button:has-text("Allow"), .chat-widget .monaco-button:has-text("Continue")'
    ).first();
    if (await approve.isVisible().catch(() => false)) {
      log('    (auto-approving agent action)');
      await approve.click().catch(() => {});
    }
    if (await stop.isVisible().catch(() => false)) {
      seenGenerating = true;
      hiddenStreak = 0;
      return false;
    }
    // Done when a generation we saw has ended — or, for a turn too fast
    // to catch in the act, when the stop button stayed hidden for two
    // consecutive polls (one hidden reading right after sending is not
    // reliable: generation takes a beat to start).
    hiddenStreak++;
    return seenGenerating || hiddenStreak >= 2;
  }, 'the chat turn to finish');
  await W(1500);
}

/** Select the chat model via Chanh's own command (loads it if needed). */
async function ensureChatModelSelected() {
  await discoverModels();
  if (!CONFIG.chatModel) {
    throw new Error('no downloaded chat model found — is the server running? (or set DEMO_CHAT_MODEL)');
  }
  await palette('Chanh: Select Chat Model');
  const row = win.locator(QUICK_ROW, { hasText: CONFIG.chatModel }).first();
  await waitVisible(row, 'the chat model in the picker');
  await row.click();
  await W(1500); // model load can take a moment
}

async function screenshot(name) {
  const file = path.join(CONFIG.workspace, name);
  await win.screenshot({ path: file });
  log(`  saved ${name}`);
}

/**
 * The one waiting pattern — there are no timeouts in this script.
 * pollUntil runs `check` every 3 seconds, forever, until it returns
 * true, logging a heartbeat every ~30s so a long wait never looks
 * dead. A wrong selector therefore hangs visibly instead of failing
 * on an arbitrary number: fix the selector, not a timeout.
 */
async function pollUntil(check, what, deadlineMs) {
  const started = Date.now();
  let polls = 0;
  for (;;) {
    if (await check()) return;
    if (deadlineMs && Date.now() - started > deadlineMs) {
      throw new Error(`timed out after ${Math.round(deadlineMs / 1000)}s waiting for ${what}`);
    }
    polls++;
    if (polls % 10 === 0) {
      log(`    ... still waiting for ${what} (${Math.round((Date.now() - started) / 1000)}s)`);
    }
    await W(3000);
  }
}

/** Poll every 3s until `locator` is visible — the locator form of pollUntil. */
async function waitVisible(locator, what) {
  await pollUntil(() => locator.isVisible().catch(() => false), what);
}

// ---------------------------------------------------------------------------
// Built-in recording: Chromium screencast frames -> per-scene MP4.
// The screencast emits a frame whenever the window's pixels change, each
// with a timestamp; the MP4 is assembled with those exact durations, so
// static beats hold and motion stays in sync. No external recorder.
// ---------------------------------------------------------------------------

let ffmpegPath = null; // resolved by ensureFfmpeg() during preflight

const FFMPEG_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

function findFileNamed(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFileNamed(full, name);
      if (hit) return hit;
    } else if (entry.name === name) return full;
  }
  return null;
}

/**
 * Resolve an ffmpeg binary without any npm package: a system ffmpeg on
 * PATH wins, then a previously downloaded copy in ./bin, else download
 * the bin once (~130 MB) and keep it in ./bin for future runs.
 */
async function ensureFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const onPath = await new Promise((resolve) => {
    execFile(lookup, ['ffmpeg'], (err, stdout) => {
      if (err) return resolve(null);
      const hit = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
      resolve(hit || null);
    });
  });
  if (onPath) {
    ffmpegPath = onPath;
    log('ffmpeg: using system binary at ' + onPath);
    return ffmpegPath;
  }
  const binDir = path.join(__dirname, 'bin');
  const local = path.join(binDir, 'ffmpeg.exe');
  if (fs.existsSync(local)) {
    ffmpegPath = local;
    log('ffmpeg: using ' + local);
    return ffmpegPath;
  }
  log('ffmpeg: downloading the bin (one-time, ~130 MB)…');
  fs.mkdirSync(binDir, { recursive: true });
  const zip = path.join(binDir, 'ffmpeg.zip');
  const res = await fetch(FFMPEG_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`ffmpeg download failed: HTTP ${res.status} — or install ffmpeg yourself and put it on PATH`);
  await fs.promises.writeFile(zip, Buffer.from(await res.arrayBuffer()));
  const extractDir = path.join(binDir, 'extract');
  fs.rmSync(extractDir, { recursive: true, force: true });
  await new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${extractDir}' -Force`],
      (err) => (err ? reject(err) : resolve())
    );
  });
  const found = findFileNamed(extractDir, 'ffmpeg.exe');
  if (!found) throw new Error('ffmpeg.exe not found inside the downloaded zip');
  fs.copyFileSync(found, local);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  ffmpegPath = local;
  log('ffmpeg: saved to ' + local);
  return ffmpegPath;
}

const recorder = {
  session: null,
  framesDir: null,
  frames: [],
  writing: Promise.resolve(),
  outName: null,
  onFrame: null,

  async start(scene, outName) {
    if (!ffmpegPath) throw new Error('ffmpeg was not resolved (preflight should have done it)');
    if (this.session) await this.abort();
    this.outName = outName;
    this.framesDir = path.join(CONFIG.workspace, `.frames-${scene}`);
    fs.rmSync(this.framesDir, { recursive: true, force: true });
    fs.mkdirSync(this.framesDir, { recursive: true });
    this.frames = [];
    this.writing = Promise.resolve();
    this.session = await win.context().newCDPSession(win);
    this.onFrame = (ev) => {
      const file = `f${String(this.frames.length).padStart(6, '0')}.jpg`;
      this.frames.push({ file, t: ev.metadata.timestamp });
      const buf = Buffer.from(ev.data, 'base64');
      const dest = path.join(this.framesDir, file);
      this.writing = this.writing.then(() => fs.promises.writeFile(dest, buf));
      this.session.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    };
    this.session.on('Page.screencastFrame', this.onFrame);
    await this.session.send('Page.startScreencast', {
      format: 'jpeg', quality: 80, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1,
    });
    log(`  ● recording ${outName}`);
  },

  async stop() {
    if (!this.session) return;
    await this.session.send('Page.stopScreencast').catch(() => {});
    this.session.off('Page.screencastFrame', this.onFrame);
    this.session = null;
    await this.writing;
    const frames = this.frames;
    const dir = this.framesDir;
    const out = path.join(CONFIG.workspace, this.outName);
    this.frames = [];
    if (frames.length < 2) {
      throw new Error(`recording ${this.outName}: only ${frames.length} frame(s) captured`);
    }
    let list = '';
    for (let i = 0; i < frames.length; i++) {
      const dur = i + 1 < frames.length
        ? Math.max(0.01, frames[i + 1].t - frames[i].t)
        : 0.5;
      list += `file '${frames[i].file}'\nduration ${dur.toFixed(3)}\n`;
    }
    list += `file '${frames[frames.length - 1].file}'\n`;
    fs.writeFileSync(path.join(dir, 'list.txt'), list);
    await new Promise((resolve, reject) => {
      execFile(
        ffmpegPath,
        ['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
         '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
         '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
         '-movflags', '+faststart', out],
        { cwd: dir },
        (err, _so, se) => (err
          ? reject(new Error('ffmpeg failed: ' + String(se).slice(-400)))
          : resolve())
      );
    });
    fs.rmSync(dir, { recursive: true, force: true });
    log(`  ■ saved ${this.outName} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
  },

  /** Stop capturing without encoding (failed scene); frames stay on disk. */
  async abort() {
    if (!this.session) return;
    await this.session.send('Page.stopScreencast').catch(() => {});
    this.session.off('Page.screencastFrame', this.onFrame);
    this.session = null;
    this.frames = [];
    log(`    recording aborted; frames kept in ${path.basename(this.framesDir || '')}`);
  },
};

// ---------------------------------------------------------------------------
// Scenes. Each video scene records itself (2s of still lead-in/out inside
// the recording, for trim padding). Scenes run in canonical order
// regardless of the order they were requested in, and each is independent
// enough to rerun alone.
// ---------------------------------------------------------------------------

/** Scene 2 — lemond download + server start (fresh profile => no binary). */
async function s2() {
  mark('s2', 'start');
  await recorder.start('s2', 's2-install.mp4');
  await W(2000);
  await palette('Chanh: Start Server');
  // The missing-binary prompt is a notification whose Download action is
  // an anchor-styled monaco-button, not a <button> element — and it can
  // appear at any point while the server comes up. Race it: click
  // Download whenever it shows, until the model sections populate.
  const downloadBtn = win.locator(
    '.notifications-toasts .monaco-button:has-text("Download"), ' +
    '.notification-list-item .monaco-button:has-text("Download"), ' +
    '.notifications-toasts a:has-text("Download")'
  ).first();
  let downloadClicked = false;
  let restarted = false;
  let checks = 0;
  await pollUntil(async () => {
    if (!downloadClicked && (await downloadBtn.isVisible().catch(() => false))) {
      await downloadBtn.click();
      downloadClicked = true;
      log('    binary download prompt: clicked Download');
    }
    // Installing the binary does NOT start the server — once the install
    // has fully completed, Start Server has to be run a second time.
    if (downloadClicked && !restarted && installComplete()) {
      log('    binary install complete — running Start Server again');
      await palette('Chanh: Start Server').catch((e) => log(`    (re-start failed: ${e.message})`));
      restarted = true;
    }
    checks++;
    if (await anyRowVisible('Installed Models')) return true;
    if (checks % 10 === 0) {
      const n = await win
        .locator('.sidebar .monaco-list-row', { hasText: 'Installed Models' })
        .count().catch(() => -1);
      log(`    (diagnostic: ${n} row(s) match "Installed Models", none on screen yet)`);
    }
    return false;
  }, 'the server sections to appear');
  // Sections only populate once the server is actually running.
  await treeRow('Downloadable Models');
  await W(2000);
  await recorder.stop();
  mark('s2', 'end');
}

/** Scene 3 — tree tour screenshot (a model is loaded first, for a green row). */
async function s3() {
  await ensureChatModelSelected();
  await expandSection('Installed Models');
  await expandSection('Downloadable Models');
  const system = await treeRow('System');
  await system.scrollIntoViewIfNeeded().catch(() => {});
  await W(1000);
  await screenshot('s3-tree.png');
}

/** Scene 4 — one-click model download, ending when it lands in Installed. */
async function s4() {
  await discoverModels();
  if (!CONFIG.downloadModel) {
    throw new Error('no not-downloaded chat model found (or set DEMO_DOWNLOAD_MODEL)');
  }
  await expandSection('Downloadable Models');
  // The downloadable model is listed at the end of the section, below the
  // fold of the virtualized treeview. Scroll the treeview down a bit so it
  // comes into view before we try to click its "Download Model" action.
  await win
    .locator('.sidebar .monaco-list')
    .first()
    .evaluate((el) => {
      el.scrollTop = Math.min(el.scrollTop + 400, el.scrollHeight - el.clientHeight);
    })
    .catch(() => {});
  await W(500);
  mark('s4', 'start');
  await recorder.start('s4', 's4-download.mp4');
  await W(2000);
  await rowInlineAction(CONFIG.downloadModel, 'Download Model');
  await pollUntil(async () => {
    if (await anyRowVisible('Downloading Models')) return false;
    const installed = await expandSection('Installed Models');
    return installed.evaluate((header, model) => {
      // Monaco renders a flat, virtualized tree; DOM order can be recycled.
      const rows = [...header.closest('.monaco-list').querySelectorAll('.monaco-list-row')]
        .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
      const level = Number(header.getAttribute('aria-level'));
      for (let i = rows.indexOf(header) + 1; i < rows.length; i++) {
        const row = rows[i];
        if (Number(row.getAttribute('aria-level')) <= level) break;
        if ((row.textContent || '').includes(model) && row.getClientRects().length > 0) return true;
      }
      return false;
    }, CONFIG.downloadModel).catch(() => false);
  }, 'the download to finish');
  await W(2000);
  await recorder.stop();
  mark('s4', 'end');
}

/** Scene 6 — model info panel screenshot. */
async function s6() {
  await discoverModels();
  const model = CONFIG.toolModel || CONFIG.chatModel;
  if (!model) throw new Error('no downloaded model found for the info panel (or set DEMO_TOOL_MODEL)');
  await expandSection('Installed Models');
  await rowInlineAction(model, 'Show Model Info');
  // The info panel is a webview editor; poll until its frame shows content.
  await pollUntil(async () => {
    for (const frame of win.frames()) {
      const text = await frame.locator('body').innerText().catch(() => '');
      if (/capabilit/i.test(text)) return true;
    }
    return false;
  }, 'the model-info webview');
  await W(1500);
  await screenshot('s6-modelinfo.png');
  // Close the info editor again if it is the active tab.
  const tab = await win.locator('.tabs .tab.active').first().innerText().catch(() => '');
  if (/info/i.test(tab)) await win.keyboard.press('Control+W');
}

/** Scene 7 — @chanh /fix on the buggy greet() selection. */
async function s7() {
  await ensureServerRunning();
  await ensureChatModelSelected();
  await openFileQuick('main.js');
  mark('s7', 'start');
  await recorder.start('s7', 's7-fix.mp4');
  await W(2000);
  // Select the greet function (lines 2-4 of the script-created main.js).
  const line = win.locator('.editor .view-lines .view-line').nth(1);
  await line.click();
  await win.keyboard.press('Home');
  await win.keyboard.press('Shift+Down');
  await win.keyboard.press('Shift+Down');
  await win.keyboard.press('Shift+End');
  await W(800);
  const input = await openChat();
  await input.click();
  await input.pressSequentially('@', { delay: 150 });
  await pickSuggestion('Chanh');
  await input.pressSequentially('/', { delay: 150 });
  await pickSuggestion('fix');
  await W(600);
  await win.keyboard.press('Enter');
  await waitChatIdle();
  await W(2000);
  await recorder.stop();
  mark('s7', 'end');
}

/** Scene 8 — slash menu screenshot (needs Scene 7's answer + chips in Chat). */
async function s8() {
  const input = await openChat();
  await input.click();
  await input.pressSequentially('/', { delay: 150 });
  const row = win.locator('.suggest-widget .monaco-list-row', { hasText: 'fix' }).first();
  await waitVisible(row, 'the slash-command menu');
  await W(700);
  await screenshot('s8-slash.png');
  await win.keyboard.press('Escape');
  await input.click();
  await win.keyboard.press('Control+A');
  await win.keyboard.press('Backspace');
}

/** Scene 9 — native model picker -> Agent mode -> tool calls (money shot). */
async function s9() {
  await discoverModels();
  if (!CONFIG.toolModel) {
    throw new Error('no downloaded tool-calling model found (or set DEMO_TOOL_MODEL)');
  }
  await openFileQuick('main.js');
  const input = await openChat();
  mark('s9', 'start');
  await recorder.start('s9', 's9-agent.mp4');
  await W(2000);
  // Model picker: slow, readable beats between open -> provider -> model.
  const pickerCandidates = [
    win.locator('.chat-widget .chat-model-picker').first(),
    win.locator('.chat-widget [aria-label*="Model"]').first(),
    win.getByRole('button', { name: /model/i }).first(),
  ];
  let picker = null;
  for (const c of pickerCandidates) {
    if (await c.isVisible().catch(() => false)) { picker = c; break; }
  }
  if (!picker) throw new Error('model picker button not found (calibration needed)');
  await picker.click();
  await W(1400);
  const modelRow = win.locator(QUICK_ROW, { hasText: CONFIG.toolModel }).first();
  await waitVisible(modelRow, 'the tool model in the picker');
  await W(1000);
  await modelRow.click();
  await W(1200);
  // Mode dropdown: switch to Agent.
  const modeBtn = win.locator(
    '.chat-widget [aria-label*="Mode"], .chat-widget button:has-text("Ask")'
  ).first();
  await waitVisible(modeBtn, 'the mode dropdown');
  await modeBtn.click();
  await W(900);
  const agentItem = win.locator(
    '.monaco-menu .action-label:has-text("Agent"), ' + QUICK_ROW + ':has-text("Agent")'
  ).first();
  await waitVisible(agentItem, 'the Agent menu item');
  await agentItem.click();
  await W(1000);
  await input.click();
  await input.pressSequentially('add null guards to main.js', { delay: 90 });
  await W(600);
  await win.keyboard.press('Enter');
  await waitChatIdle();
  await W(2000);
  await recorder.stop();
  mark('s9', 'end');
}

/** Scene 5 — System group while a model generates (own short /explain turn). */
async function s5() {
  await openChanhSidebar();
  const system = await treeRow('System');
  await system.scrollIntoViewIfNeeded().catch(() => {});
  await openFileQuick('helpers.js');
  const editor = win.locator('.editor .view-lines').first();
  await editor.click();
  await win.keyboard.press('Control+A');
  const input = await openChat();
  mark('s5', 'start');
  await recorder.start('s5', 's5-sysmon.mp4');
  await input.click();
  await input.pressSequentially('@', { delay: 150 });
  await pickSuggestion('Chanh');
  await input.pressSequentially('/', { delay: 150 });
  await pickSuggestion('explain');
  await win.keyboard.press('Enter');
  await waitChatIdle();
  await recorder.stop();
  mark('s5', 'end');
}

const SCENE_FNS = { s2, s3, s4, s5, s6, s7, s8, s9 };

/** One-line description per scene, printed as each task starts. */
const SCENE_DESCRIPTIONS = {
  s2: 'download the lemond binary and start the server',
  s3: 'tour the sidebar tree (screenshot)',
  s4: 'download a model in one click',
  s5: 'system monitor while a model generates',
  s6: 'model info panel (screenshot)',
  s7: 'fix the buggy greet() with @chanh /fix',
  s8: 'slash-command menu (screenshot)',
  s9: 'agent mode via the native model picker (money shot)',
};

/** The model each scene runs on ('' when the scene uses none). */
function sceneModel(scene) {
  switch (scene) {
    case 's2': return '';
    case 's4': return CONFIG.downloadModel;
    case 's9': return CONFIG.toolModel;
    case 's6': return CONFIG.toolModel || CONFIG.chatModel;
    default: return CONFIG.chatModel; // s3, s5, s7, s8
  }
}

// ---------------------------------------------------------------------------
// Auto-detection: no env vars needed in the normal case.
// ---------------------------------------------------------------------------

function detectCodePath() {
  if (CONFIG.codePath) return CONFIG.codePath;
  const candidates = [
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || '';
}

function detectRepo() {
  if (CONFIG.chanhRepo) return CONFIG.chanhRepo;
  // This folder lives inside the repo: <repo>/chanh-demo-automation/.
  for (const dir of [path.resolve(__dirname, '..'), __dirname]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'chanh') return dir;
    } catch { /* not the repo root */ }
  }
  return '';
}

/** Remove a previously installed lemond binary so Scene 2 downloads it fresh. */
function removeBinary() {
  const binDir = path.join(
    CONFIG.userData, 'User', 'globalStorage', 'lanly-dev.chanh', 'bin'
  );
  if (fs.existsSync(binDir)) {
    fs.rmSync(binDir, { recursive: true, force: true });
    log('removed previously installed lemond binary (Scene 2 downloads it fresh)');
  }
}

/**
 * End this run's own server tree: lemond plus the llama-server children it
 * spawns. Killing the extension host does NOT kill them — lemond is spawned by
 * the extension, not by this script, so an interrupted run leaves both alive
 * and holding the demo port.
 *
 * Scoped on purpose: only processes whose executable lives inside this run's
 * --user-data-dir are touched, so an independent Lemonade install on the
 * machine (or another profile's) is never hit. Windows-only; no-op elsewhere.
 */
function killDemoServer(reason) {
  if (process.platform !== 'win32') return [];
  const port = Number(SETTINGS['chanh.lemondPort']) || 0;
  const script = `
$userData = '${CONFIG.userData.replace(/'/g, "''")}'
$pids = @()
if (${port} -gt 0) {
  try {
    $owners = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($p in $owners) {
      $pr = Get-Process -Id $p -ErrorAction SilentlyContinue
      if ($pr) { $exe = $null; try { $exe = $pr.Path } catch { }; if ($exe -and $exe.StartsWith($userData, 'OrdinalIgnoreCase')) { $pids += $p } }
    }
  } catch { }
}
foreach ($pr in (Get-Process -Name llama-server,lemond -ErrorAction SilentlyContinue)) {
  $exe = $null; try { $exe = $pr.Path } catch { }
  if ($exe -and $exe.StartsWith($userData, 'OrdinalIgnoreCase')) { $pids += $pr.Id }
}
$pids = @($pids | Sort-Object -Unique)
foreach ($p in $pids) { taskkill /PID $p /T /F 2>&1 | Out-Null }
Write-Output ($pids -join ',')
`;
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ], { encoding: 'utf8', timeout: 20000 });
    const killed = String(out).trim().split(',').filter(Boolean);
    if (killed.length > 0) {
      log(`  server cleanup${reason ? ` (${reason})` : ''}: killed PID(s) ${killed.join(', ')}`);
    }
    return killed;
  } catch (err) {
    log(`  server cleanup failed: ${(err && err.message) || err}`);
    return [];
  }
}

/**
 * Has the binary install FULLY completed? The extension extracts the
 * archive, then merges the layout (resources/, config, …) next to the
 * executable, and only then writes `.version` — so lemond.exe at the
 * layout root + `.version` is the completion marker. (lemond.exe alone
 * appears mid-extraction; starting the server then launches it from a
 * half-copied tree with resources/ missing, and it exits code 1.)
 */
function installComplete() {
  const binDir = path.join(
    CONFIG.userData, 'User', 'globalStorage', 'lanly-dev.chanh', 'bin', 'lemonade-server'
  );
  const exe = process.platform === 'win32' ? 'lemond.exe' : 'lemond';
  return fs.existsSync(path.join(binDir, exe)) && fs.existsSync(path.join(binDir, '.version'));
}

async function serverAvailable(base) {
  try {
    return (await fetch(`${base}/v1/health`)).ok;
  } catch {
    return false;
  }
}

/** Prepare a standalone Scene 7 before model discovery or selection. */
async function ensureServerRunning() {
  const available = () => serverAvailable(discoveryBase);
  if (await available()) return;
  if (SETTINGS['chanh.serverMode'] === 'LEMOND') {
    if (!installComplete()) {
      await palette('Chanh: Download/Update Binary');
      await pollUntil(() => installComplete(), 'the managed binary install to finish');
    }
    await palette('Chanh: Start Server');
  }
  await pollUntil(available, 'the selected server to become available');
}

async function fetchCatalog(base) {
  try {
    const res = await fetch(`${base}/v1/models?show_all=true`);
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json.data) ? json.data : null;
  } catch {
    return null;
  }
}

/**
 * Fill any unset model picks from the Lemonade server's own catalog:
 * first downloaded tool-calling model -> Scene 9, first downloaded chat
 * model -> Scenes 3/6/7, smallest not-downloaded chat model -> Scene 4.
 * The managed server (LEMOND, on the demo-settings port) is tried
 * first, then a system install (:13305) unless Scene 2 needs LEMOND.
 * Preflight pins the endpoint before writing the profile; later discovery
 * stays on that server. Explicit model env values always win.
 */
let discoveryBase = '';
let discoveryDone = false;
let discoveryMissLogged = false;
async function discoverModels() {
  if (discoveryDone) return;
  const managedBase = `http://localhost:${SETTINGS['chanh.lemondPort']}`;
  const bases = discoveryBase ? [discoveryBase] : [managedBase];
  if (!discoveryBase && !SCENES.includes('s2')) bases.push('http://localhost:13305');
  for (const base of bases) {
    const models = await fetchCatalog(base);
    if (!models) continue;
    discoveryBase = base;
    SETTINGS['chanh.serverMode'] = base === managedBase ? 'LEMOND' : 'LEMONADE';
    if (SETTINGS['chanh.serverMode'] === 'LEMONADE') SETTINGS['chanh.lemonadePort'] = 13305;
    const has = (m, label) => (m.labels || []).some((l) => l.toLowerCase() === label);
    // The catalog ships an upstream smoke-test fixture, Tiny-Test-Model-GGUF
    // (a made-up alias for a 270M Gemma checkpoint): never a demo pick —
    // and at 0.18 GB it would always win "smallest not-downloaded".
    const real = (m) => !/test/i.test(m.id);
    const installed = models.filter((m) => m.downloaded && real(m));
    if (!CONFIG.toolModel) {
      const m = installed.find((m) => has(m, 'tool-calling'));
      if (m) CONFIG.toolModel = m.id;
    }
    if (!CONFIG.chatModel) {
      const m = installed.find((m) => has(m, 'chat')) || installed[0];
      if (m) CONFIG.chatModel = m.id;
    }
    if (!CONFIG.downloadModel) {
      const pool = models
        .filter((m) => !m.downloaded && real(m) && has(m, 'chat'))
        .sort((a, b) => (a.size ?? 999) - (b.size ?? 999));
      if (pool[0]) CONFIG.downloadModel = pool[0].id;
    }
    log(`    models (via ${base}): chat=${CONFIG.chatModel || '?'} ` +
        `tool=${CONFIG.toolModel || '?'} download=${CONFIG.downloadModel || '?'}`);
    discoveryDone = true;
    return;
  }
  // No latch on a miss: before Scene 2 no server is up yet, and a later
  // scene must be allowed to retry once it is.
  if (!discoveryMissLogged) {
    discoveryMissLogged = true;
    log(`    model auto-detect: no Lemonade server answered at ${bases.join(' or ')}`);
  }
}

// ---------------------------------------------------------------------------
// Preflight + main
// ---------------------------------------------------------------------------

async function preflight() {
  // Resolve ffmpeg up front (system PATH, ./bin, or one-time download) —
  // never mid-scene, where a missing binary would fail takes one by one.
  await ensureFfmpeg();
  CONFIG.codePath = detectCodePath();
  if (!CONFIG.codePath) {
    throw new Error('VS Code executable not found in the standard locations (set DEMO_CODE_PATH)');
  }
  CONFIG.chanhRepo = detectRepo();
  if (!CONFIG.chanhRepo) {
    throw new Error('vscode-chanh repo not found — put this folder inside the repo, or set DEMO_CHANH_REPO');
  }
  log('code:', CONFIG.codePath);
  log('repo:', CONFIG.chanhRepo);
  fs.mkdirSync(CONFIG.workspace, { recursive: true });
  for (const [name, content] of [['main.js', MAIN_JS], ['helpers.js', HELPERS_JS]]) {
    const file = path.join(CONFIG.workspace, name);
    if (!fs.existsSync(file)) { fs.writeFileSync(file, content); log(`created ${name}`); }
  }
  if (!FLAGS.has('--keep-state')) {
    fs.rmSync(CONFIG.userData, { recursive: true, force: true });
    log('wiped .vscode-user-data (blank profile; pass --keep-state to reuse)');
  }
  if (SCENES.includes('s2')) removeBinary();
  // A leftover lemond from an interrupted run still holds the demo port, and
  // its llama-server children keep the GPU busy. Kill this run's own tree
  // before launching — scoped to executables under our --user-data-dir.
  killDemoServer('stale before launch');
  const managedBase = `http://localhost:${SETTINGS['chanh.lemondPort']}`;
  const managedAvailable = await serverAvailable(managedBase);
  if (managedAvailable) {
    log(`  ! port ${SETTINGS['chanh.lemondPort']} still answers after cleanup — something else owns it`);
  }
  // Scene 2 must install/start the managed server on camera. Other runs
  // can reuse a server, but its endpoint must reach settings before launch.
  if (!SCENES.includes('s2') && (managedAvailable || await serverAvailable('http://localhost:13305'))) {
    await discoverModels();
  }
  discoveryBase ||= managedBase;
  const userDir = path.join(CONFIG.userData, 'User');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify(SETTINGS, null, 2));
  log('workspace:', CONFIG.workspace);
  log('scenes:', SCENES.join(', '));
}

async function main() {
  await preflight();
  log('launching VS Code (dev host)…');
  app = await _electron.launch({
    executablePath: CONFIG.codePath,
    args: [
      `--user-data-dir=${CONFIG.userData}`,
      `--extensions-dir=${path.join(CONFIG.userData, 'extensions')}`,
      `--extensionDevelopmentPath=${CONFIG.chanhRepo}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      CONFIG.workspace,
    ],
    timeout: 0, // no launch timeout — startup is awaited by polling for the workbench
  });
  win = await app.firstWindow();
  await waitVisible(win.locator('.monaco-workbench'), 'the VS Code workbench');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (w) w.maximize();
  }).catch(() => {});
  await W(3000);
  await openChanhSidebar();

  t0 = Date.now();
  log('recording is built in — keep the VS Code window visible and on top during the run');

  for (const scene of SCENES) {
    // Resolve the model picks before announcing the scene (Scene 2 is
    // what brings the server up; standalone Scene 7 prepares it itself).
    if (scene !== 's2' && scene !== 's7') await discoverModels();
    log(`\n=== ${scene} — ${SCENE_DESCRIPTIONS[scene]} ===`);
    const model = sceneModel(scene);
    if (model) log(`    model: ${model}`);
    try {
      await SCENE_FNS[scene]();
      results.push({ scene, ok: true });
      log(`✓ ${scene} done`);
    } catch (err) {
      await recorder.abort().catch(() => {});
      results.push({ scene, ok: false, error: String((err && err.message) || err) });
      log(`✗ ${scene} FAILED: ${(err && err.message) || err}`);
      await win.screenshot({
        path: path.join(CONFIG.workspace, `debug-${scene}.png`),
      }).catch(() => {});
      if (FLAGS.has('--stop-on-error')) break;
    }
  }

  writeTimeline();
  const failed = results.filter((r) => !r.ok);
  log(`\n=== summary: ${results.length - failed.length}/${results.length} scenes ok ===`);
  for (const r of results) log(`  ${r.ok ? '✓' : '✗'} ${r.scene}${r.ok ? '' : ' — ' + r.error}`);

  process.exitCode = failed.length ? 1 : 0;
  if (FLAGS.has('--keep-open')) return;
  await app.close();
  killDemoServer('run end');
  process.exit(process.exitCode);
}

// Ctrl+C kills this process but NOT the extension host's children: lemond is
// spawned by the extension, and lemond spawns llama-server. Close the window
// first, then end the leftover tree so the next run can bind the demo port.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    log(`\n${sig} — closing VS Code and ending the demo server…`);
    try { if (app) await app.close(); } catch { /* ignore */ }
    killDemoServer('interrupted');
    process.exit(130);
  });
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  try { if (app && !FLAGS.has('--keep-open')) await app.close(); } catch { /* ignore */ }
  killDemoServer('fatal');
  process.exitCode = 2;
});
