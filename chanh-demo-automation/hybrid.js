#!/usr/bin/env node
/**
 * hybrid.js — the Chanh demo, performed by YOU, stage-managed by this script.
 *
 * demo.js drives VS Code with Playwright and keeps missing on real
 * machines (selectors, timing, focus). This hybrid keeps the parts that
 * always worked — the blank demo profile, the exact workspace files, the
 * built-in recording, the scene order and filenames — and hands the UI
 * steps back to a human: for each scene it prints numbered instructions,
 * starts the recording, and waits for you to press Enter when the take
 * is done. Screenshots are grabbed by the script at your Enter.
 *
 * demo.js is untouched and remains the automated path (and a useful
 * test harness); this file shares its setup constants by design.
 *
 * Usage:
 *   node hybrid.js              all scenes, canonical order
 *   node hybrid.js s7           one scene (s2 s3 s4 s5 s6 s7 s8 s9)
 *   node hybrid.js --list       print every scene's instructions, no launch
 *   flags: --keep-state         reuse .vscode-user-data instead of wiping it
 *          --keep-open          leave VS Code open when finished
 *
 * Zero config, same as demo.js: Code.exe and the repo are auto-detected,
 * model names are read from the Lemonade catalog when a server answers
 * (env DEMO_CODE_PATH / DEMO_CHANH_REPO / DEMO_WORKSPACE /
 * DEMO_CHAT_MODEL / DEMO_TOOL_MODEL / DEMO_DOWNLOAD_MODEL override).
 * Keep the VS Code window visible and on top while recording.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');

const env = process.env;
const WORKSPACE = env.DEMO_WORKSPACE || path.join(os.homedir(), 'demo-workspace');
const CONFIG = {
  codePath: env.DEMO_CODE_PATH || '',
  chanhRepo: env.DEMO_CHANH_REPO || '',
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
const unknown = requested.filter((s) => !CANONICAL.includes(s));
if (unknown.length > 0) {
  console.error(`Unknown scene names: ${unknown.join(', ')}. Valid options: ${CANONICAL.join(', ')}`);
  process.exit(1);
}
const SCENES = CANONICAL.filter((s) => requested.length === 0 || requested.includes(s));

// The demo project files — identical to demo.js so the workspace is exact.
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

// Settings for the blank profile — identical to demo.js.
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

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The guide: one entry per scene. Steps are the manual version of exactly
// what demo.js performs automatically (same prompts, same order).
// ---------------------------------------------------------------------------

const GUIDE = {
  s2: {
    desc: 'download the lemond binary and start the server',
    kind: 'video', file: 's2-install.mp4', model: '',
    steps: [
      'In the Chanh sidebar, click Start Server (or press F1 and run "Chanh: Start Server").',
      'A notification asks to download the Lemonade Server binary — click Download.',
      'Wait for the download to finish (the progress notification completes; the extension confirms "downloaded successfully").',
      'Click Start Server AGAIN — installing the binary does not start the server.',
      'Wait until the tree shows the server Running, with "Installed Models" and "Downloadable Models" sections.',
      'Hold the final view for about 2 seconds — that is the end of the take.',
    ],
  },
  s3: {
    desc: 'tour the sidebar tree (screenshot)',
    kind: 'screenshot', file: 's3-tree.png', model: 'chat',
    steps: [
      'In the sidebar tree, expand "Installed Models" and "Downloadable Models".',
      'Make sure the chat model named above is loaded (its row shows the green dot; click the row\'s load action if not).',
      'Scroll the tree so the "System" group is visible too.',
      'Arrange the tree until it looks like the tour shot — server status, both model sections, System group.',
    ],
  },
  s4: {
    desc: 'download a model in one click',
    kind: 'video', file: 's4-download.mp4', model: 'download',
    steps: [
      'In the tree, expand "Downloadable Models" and scroll to the model named above.',
      'Hover its row and click the "Download Model" action (the down-arrow icon at the right of the row).',
      'Wait while it downloads — a "Downloading Models" section shows the progress.',
      'The take is done when the model appears under "Installed Models" and "Downloading Models" is gone. Hold about 2 seconds.',
    ],
  },
  s6: {
    desc: 'model info panel (screenshot)',
    kind: 'screenshot', file: 's6-modelinfo.png', model: 'info',
    steps: [
      'In the tree, expand "Installed Models" and find the model named above.',
      'Hover its row and click "Show Model Info" (the info icon).',
      'Wait for the info panel to open and fill in (you can see its capabilities list).',
      'If the panel\'s "Created" date looks absurd (e.g. 2009), close the panel and use a different downloaded model instead.',
    ],
  },
  s7: {
    desc: 'fix the buggy greet() with @chanh /fix',
    kind: 'video', file: 's7-fix.mp4', model: 'chat',
    steps: [
      'Open main.js (Ctrl+P, type main.js, Enter).',
      'Select the greet() function: click at the very start of line 2, then Shift+click at the end of line 4.',
      'Open Chat (Ctrl+Alt+I) and click the chat input.',
      'Type @ and pick "Chanh", then type / and pick "fix" — the input reads "@chanh /fix".',
      'Press Enter and wait for the answer to finish (the stop button disappears and a token footer shows).',
      'Hold about 2 seconds — that is the end of the take.',
    ],
  },
  s8: {
    desc: 'slash-command menu (screenshot)',
    kind: 'screenshot', file: 's8-slash.png', model: 'chat',
    needs: 'Scene 7 must have run in this same window first (its chat and follow-up chips are in this shot).',
    steps: [
      'In the same chat from Scene 7, click the chat input.',
      'Type a single / — the slash-command menu opens.',
      'Leave the menu open, exactly as the screenshot should look.',
    ],
  },
  s9: {
    desc: 'agent mode via the native model picker (money shot)',
    kind: 'video', file: 's9-agent.mp4', model: 'tool',
    steps: [
      'Open main.js (Ctrl+P, type main.js, Enter).',
      'Open Chat (Ctrl+Alt+I) and click the model picker at the bottom of the chat panel.',
      'Choose the model named above (the downloaded tool-calling one).',
      'Click the mode dropdown (it says "Ask") and switch to "Agent".',
      'Click the chat input and type exactly: add null guards to main.js — then press Enter.',
      'Whenever VS Code asks to allow a tool call or edit, click Allow. Repeat until the edit lands in main.js and the answer finishes (token footer visible).',
      'Hold about 2 seconds — that is the end of the take.',
    ],
  },
  s5: {
    desc: 'system monitor while a model generates',
    kind: 'video', file: 's5-sysmon.mp4', model: 'chat',
    steps: [
      'In the Chanh sidebar, scroll the "System" group into view.',
      'Open helpers.js (Ctrl+P, type helpers.js, Enter), click in the editor, and press Ctrl+A to select all.',
      'Open Chat, click the input, type @ and pick "Chanh", then type / and pick "explain". Press Enter.',
      'While the answer generates, the System group shows CPU/GPU/RAM moving live — let it run.',
      'The take is done when the answer finishes.',
    ],
  },
};

const MODEL_HINTS = {
  chat: 'a downloaded chat model',
  tool: 'a downloaded tool-calling model',
  download: 'the model Scene 4 downloads (smallest not-downloaded chat model)',
  info: 'a downloaded model (tool-calling preferred)',
};

function sceneModel(scene) {
  switch (GUIDE[scene].model) {
    case 'chat': return CONFIG.chatModel;
    case 'tool': return CONFIG.toolModel;
    case 'download': return CONFIG.downloadModel;
    case 'info': return CONFIG.toolModel || CONFIG.chatModel;
    default: return '';
  }
}

function printGuide(scene) {
  const g = GUIDE[scene];
  log(`\n=== ${scene} — ${g.desc} ===`);
  log(`    ${g.kind === 'video' ? 'records' : 'screenshots'}: ${g.file}`);
  if (g.model) {
    const m = sceneModel(scene);
    log(m ? `    model: ${m}` : `    model: ${MODEL_HINTS[g.model]} (auto-detect found none)`);
  }
  if (g.needs) log(`    note: ${g.needs}`);
  log('  Do this yourself in the VS Code window:');
  g.steps.forEach((s, i) => log(`    ${i + 1}. ${s}`));
}

// ---------------------------------------------------------------------------
// ffmpeg: same resolution as demo.js (system PATH -> ./bin -> one download)
// ---------------------------------------------------------------------------

let ffmpegPath = null;
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

// ---------------------------------------------------------------------------
// Detection + model catalog (mirrors demo.js; picks only feed the printed
// "model:" line — you click everything yourself)
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
  for (const dir of [path.resolve(__dirname, '..'), __dirname]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'chanh') return dir;
    } catch { /* not the repo root */ }
  }
  return '';
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

let discoveryDone = false;
async function discoverModels() {
  if (discoveryDone) return;
  // Env overrides bypass the fixture filter (explicit picks win) — but an
  // env var naming the smoke-test fixture is a stale leftover, never an
  // intent. Drop test-named values so the printed model is a real one.
  for (const key of ['chatModel', 'toolModel', 'downloadModel']) {
    if (CONFIG[key] && /test/i.test(CONFIG[key])) {
      log(`    ignoring a test-fixture model override for ${key} ("${CONFIG[key]}")`);
      CONFIG[key] = '';
    }
  }
  if (CONFIG.chatModel && CONFIG.toolModel && CONFIG.downloadModel) {
    discoveryDone = true;
    return;
  }
  for (const base of [`http://localhost:${SETTINGS['chanh.lemondPort']}`, 'http://localhost:13305']) {
    const models = await fetchCatalog(base);
    if (!models) continue;
    const has = (m, label) => (m.labels || []).some((l) => l.toLowerCase() === label);
    const real = (m) => !/test/i.test(m.id); // Tiny-Test-Model-GGUF is an upstream fixture
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
}

// ---------------------------------------------------------------------------
// Recorder: CDP screencast -> ffmpeg, same as demo.js.
// ---------------------------------------------------------------------------

let app = null;
let win = null;

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
// Preflight + main
// ---------------------------------------------------------------------------

function removeBinary() {
  const binDir = path.join(
    CONFIG.userData, 'User', 'globalStorage', 'lanly-dev.chanh', 'bin'
  );
  if (fs.existsSync(binDir)) {
    fs.rmSync(binDir, { recursive: true, force: true });
    log('removed previously installed lemond binary (Scene 2 downloads it fresh)');
  }
}

async function preflight() {
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
  try {
    const res = await fetch(`http://localhost:${SETTINGS['chanh.lemondPort']}/v1/health`);
    if (res.ok) {
      log(`  ! port ${SETTINGS['chanh.lemondPort']} already answers — a leftover lemond may be running;`);
      log('    end stray lemond.exe processes (Task Manager) first, or the start will conflict');
    }
  } catch { /* nothing listening — the expected case */ }
  const userDir = path.join(CONFIG.userData, 'User');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify(SETTINGS, null, 2));
  log('workspace:', CONFIG.workspace);
  log('scenes:', SCENES.join(', '));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, () => resolve()));

async function main() {
  if (FLAGS.has('--list')) {
    for (const scene of SCENES) {
      await discoverModels().catch(() => {});
      printGuide(scene);
    }
    log('\n(--list only — nothing launched)');
    rl.close();
    return;
  }

  // Lazy: --list above must work before `npm install`.
  const { _electron } = require('playwright');

  await preflight();
  log('launching VS Code (dev host)…');
  const launchEnv = { ...process.env };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  delete launchEnv.ELECTRON_NO_ATTACH_CONSOLE;
  app = await _electron.launch({
    executablePath: CONFIG.codePath,
    env: launchEnv,
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
  for (;;) {
    if (await win.locator('.monaco-workbench').isVisible().catch(() => false)) break;
    await sleep(3000);
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (w) w.maximize();
  }).catch(() => {});
  await sleep(2000);
  // Best effort: open the Chanh view so Scene 2 starts in the right place.
  const chanhBtn = win.locator(
    '.activitybar [aria-label*="Chanh" i], .activitybar [title*="Chanh" i]'
  ).first();
  if (await chanhBtn.isVisible().catch(() => false)) await chanhBtn.click().catch(() => {});
  log('\nVS Code is open on the demo workspace. Keep it visible and on top.');
  log('If the Chanh sidebar is not showing, click the Chanh icon in the left activity bar.');

  const t0 = Date.now();
  const timeline = [];
  const results = [];
  for (const scene of SCENES) {
    if (scene !== 's2') await discoverModels();
    printGuide(scene);
    const g = GUIDE[scene];
    try {
      if (g.kind === 'video') {
        await ask('\n  Press Enter to START recording, then do the steps above… ');
        const recStart = (Date.now() - t0) / 1000;
        await recorder.start(scene, g.file);
        await ask('  ● recording — do the steps now; press Enter here when the take is complete… ');
        await recorder.stop();
        timeline.push({ scene, file: g.file, recordStart, recordEnd: (Date.now() - t0) / 1000 });
      } else {
        await ask('\n  Arrange the shot, then press Enter to take the screenshot… ');
        await win.screenshot({ path: path.join(CONFIG.workspace, g.file) });
        log(`  ■ saved ${g.file}`);
        if (scene === 's8') {
          // Clear the half-typed slash so the window is clean for later scenes.
          await win.keyboard.press('Escape').catch(() => {});
        }
        timeline.push({ scene, file: g.file, at: (Date.now() - t0) / 1000 });
      }
      results.push({ scene, ok: true });
      log(`✓ ${scene} done`);
    } catch (err) {
      await recorder.abort().catch(() => {});
      results.push({ scene, ok: false, error: String((err && err.message) || err) });
      log(`✗ ${scene} FAILED: ${(err && err.message) || err} — fix it in the window, or press Enter to move on`);
      await ask('  Press Enter to continue… ');
    }
  }

  fs.writeFileSync(
    path.join(CONFIG.workspace, 'timeline.json'),
    JSON.stringify({ startedAt: new Date(t0).toISOString(), entries: timeline }, null, 2)
  );
  log('\n=== summary ===');
  for (const r of results) log(`  ${r.scene}: ${r.ok ? 'captured' : 'FAILED — ' + r.error}`);
  log(`captures are in ${CONFIG.workspace}`);

  if (FLAGS.has('--keep-open')) {
    log('leaving VS Code open (--keep-open)');
  } else {
    await ask('\nPress Enter to close VS Code and finish… ');
    await app.close().catch(() => {});
  }
  rl.close();
}

main().catch((err) => {
  console.error('\nFAILED:', err && err.message ? err.message : err);
  rl.close();
  process.exit(1);
});
