#!/usr/bin/env node
/**
 * hybrid-v2.js — the Chanh demo v2, performed by YOU, stage-managed by this script.
 *
 * Same stage-management as hybrid.js (blank profile, workspace files, built-in
 * recording, scene order and filenames) but with a different scene lineup:
 *   s1 screenshot  loaded model in the sidebar tree
 *   s2 screenshot  model info panel
 *   s3 screenshot  model selection in Copilot chat with @chanh generated
 *   s4 video       doing agent with a Lemon model
 *
 * For each scene it prints numbered instructions, starts the recording (video
 * scenes), and waits for you to press Enter when the take is done. Screenshots
 * are grabbed by the script at your Enter.
 *
 * Usage:
 *   node hybrid-v2.js              all scenes, canonical order (s1 s2 s3 s4)
 *   node hybrid-v2.js s4           one scene
 *   node hybrid-v2.js --list       print every scene's instructions, no launch
 *   flags: --keep-state         reuse .vscode-user-data instead of wiping it
 *          --keep-open          leave VS Code open when finished
 *
 * Zero config: Code.exe and the repo are auto-detected, model names are read
 * from the Lemonade catalog when a server answers
 * (env DEMO_CODE_PATH / DEMO_CHANH_REPO / DEMO_WORKSPACE /
 * DEMO_CHAT_MODEL / DEMO_TOOL_MODEL / DEMO_DOWNLOAD_MODEL override).
 * Keep the VS Code window visible and on top while recording.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile, execFileSync } = require('child_process');

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

// Captures (recordings, screenshots, timeline.json) land here so they are
// co-located with the driver scripts rather than in demo-workspace.
const OUTPUT_DIR = path.join(__dirname, 'output-v2');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const ARGS = process.argv.slice(2);
const FLAGS = new Set(ARGS.filter((a) => a.startsWith('--')));
const CANONICAL = ['s1', 's2', 's3', 's4'];
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
  'chanh.lemondPort': 10000,
};
// ---------------------------------------------------------------------------
// The guide: one entry per scene. Steps are the manual version of what you do
// yourself in the VS Code window.
// ---------------------------------------------------------------------------

const GUIDE = {
  s1: {
    desc: 'screenshot: loaded model in the sidebar tree',
    kind: 'screenshot', file: 's1-loaded.png', model: 'chat',
    steps: [
      'In the Chanh sidebar tree, expand "Installed Models".',
      'Make sure a chat model is loaded — its row shows a green dot. If not, hover the row and click its load action.',
      'Arrange the tree so the loaded model row is clearly visible.',
      'Hold the view — press Enter when ready for the screenshot.',
    ],
  },
  s2: {
    desc: 'screenshot: model info panel',
    kind: 'screenshot', file: 's2-modelinfo.png', model: 'info',
    steps: [
      'In the Chanh sidebar tree, expand "Installed Models" and find the model named above.',
      "Hover its row and click 'Show Model Info' (the info icon).",
      'Wait for the info panel to open and fill in (capabilities, context, size, etc.).',
      'Arrange the panel so its contents are readable, then press Enter for the screenshot.',
    ],
  },
  s3: {
    desc: 'screenshot: model selection in Copilot chat with @chanh generated',
    kind: 'screenshot', file: 's3-copilot-selection.png', model: 'chat',
    steps: [
      'Open Chat (Ctrl+Alt+I) and click the chat input.',
      'Type @ and pick "Chanh" from the suggestion widget.',
      'Type a short question (e.g. "hello") and press Enter so @chanh generates a reply.',
      'While/after the reply generates, the model picker/selection should be visible — arrange it so the chosen model is clear, then press Enter for the screenshot.',
    ],
  },
  s4: {
    desc: 'video: doing agent with Qwen3-0.6B-GGUF',
    kind: 'video', file: 's4-agent-lemon.mp4', model: 'chat',
    steps: [
      'Open main.js (Ctrl+P, type "main.js", Enter).',
      'Open Chat (Ctrl+Alt+I).',
      "Click the model picker at the bottom of the chat panel and choose Qwen3-0.6B-GGUF.",
      'Click the mode dropdown (currently "Ask") and switch it to "Agent".',
      'Click the chat input, type a task such as "refactor greet() to handle null and add a goodbye() function", then press Enter.',
      'Watch Qwen3-0.6B-GGUF stream its reply and propose tool calls to edit main.js.',
      'When VS Code asks to allow a tool call or file edit, click Allow. Repeat until the model finishes all edits.',
      'Confirm main.js now has the refactored greet() and the new goodbye() function.',
      'Hold the final state for about 2 seconds — that is the end of the take.',
    ],
  },
};

const MODEL_HINTS = {
  chat: 'a downloaded chat model',
  tool: 'a downloaded tool-calling (Lemon) model',
  info: 'a downloaded model (tool-calling preferred)',
};

function sceneModel(scene) {
  switch (GUIDE[scene].model) {
    case 'chat': return CONFIG.chatModel;
    case 'tool': return CONFIG.toolModel;
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
  log('  Do this yourself in the VS Code window:');
  g.steps.forEach((s, i) => log(`    ${i + 1}. ${s}`));
}

// ---------------------------------------------------------------------------
// ffmpeg: same resolution as demo.js (system PATH -> ./bin -> one download)
// ---------------------------------------------------------------------------


const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    'C:\\\\Program Files\\\\Microsoft VS Code\\\\Code.exe',
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
    if (models) {
      const chat = models.find((m) => m.labels.includes('chat') && m.downloaded);
      const tool = models.find((m) => m.labels.includes('tool-calling') && m.downloaded);
      const download = models.find((m) => m.labels.includes('chat') && !m.downloaded);
      if (!CONFIG.chatModel && chat) CONFIG.chatModel = chat.id;
      if (!CONFIG.toolModel && tool) CONFIG.toolModel = tool.id;
      if (!CONFIG.downloadModel && download) CONFIG.downloadModel = download.id;
      discoveryDone = true;
      return;
    }
  }
  discoveryDone = true;
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
    this.framesDir = path.join(OUTPUT_DIR, `.frames-${scene}`);
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
    const out = path.join(OUTPUT_DIR, this.outName);
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
// Server cleanup: kill lemond + llama-server children left behind by the
// extension host. Same scoped, Windows-only logic as demo.js.
// ---------------------------------------------------------------------------

function killDemoServer(reason) {
  if (process.platform !== 'win32') return [];
  const port = Number(SETTINGS['chanh.lemondPort']) || 0;
  const script = `
$userData = '${CONFIG.userData.replace(/'/g, "''")}'
$ProgressPreference = 'SilentlyContinue'
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

// ---------------------------------------------------------------------------
// Preflight + main
// ---------------------------------------------------------------------------

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
  // A leftover lemond from an interrupted run still holds the demo port, and
  // its llama-server children keep the GPU busy. Kill this run's own tree
  // before launching — scoped to executables under our --user-data-dir.
  killDemoServer('stale before launch');
  log('workspace:', CONFIG.workspace);
  log('scenes:', SCENES.join(', '));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, () => resolve()));

let app = null;
let win = null;

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
  // Best effort: open the Chanh view so the sidebar is ready.
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
    await discoverModels();
    printGuide(scene);
    const g = GUIDE[scene];
    try {
      if (g.kind === 'video') {
        await ask('\n  Press Enter to START recording, then do the steps above… ');
        const recordStart = (Date.now() - t0) / 1000;
        await recorder.start(scene, g.file);
        await ask('  ● recording — do the steps now; press Enter here when the take is complete… ');
        await recorder.stop();
        timeline.push({ scene, file: g.file, recordStart, recordEnd: (Date.now() - t0) / 1000 });
      } else {
        await ask('\n  Arrange the shot, then press Enter to take the screenshot… ');
        await win.screenshot({ path: path.join(OUTPUT_DIR, g.file) });
        log(`  ■ saved ${g.file}`);
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
    path.join(OUTPUT_DIR, 'timeline.json'),
    JSON.stringify({ startedAt: new Date(t0).toISOString(), entries: timeline }, null, 2)
  );
  log('\n=== summary ===');
  for (const r of results) log(`  ${r.scene}: ${r.ok ? 'captured' : 'FAILED — ' + r.error}`);
  log(`captures are in ${OUTPUT_DIR}`);

  if (FLAGS.has('--keep-open')) {
    log('leaving VS Code open (--keep-open)');
  } else {
    await ask('\nPress Enter to close VS Code and finish… ');
    await app.close().catch(() => {});
  }
  killDemoServer('run end');
  rl.close();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    log(`\n${sig} — closing VS Code and ending the demo server…`);
    try { if (app) await app.close(); } catch { /* ignore */ }
    killDemoServer('interrupted');
    process.exit(130);
  });
}

main().catch((err) => {
  console.error('\nFAILED:', err && err.message ? err.message : err);
  try { if (app && !FLAGS.has('--keep-open')) app.close().catch(() => {}); } catch { /* ignore */ }
  killDemoServer('fatal');
  rl.close();
  process.exit(1);
});

