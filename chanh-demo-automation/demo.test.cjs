const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

// Exercise the driver without launching VS Code or downloading binaries.
const source = fs.readFileSync(path.join(__dirname, 'demo.js'), 'utf8');
const driver = source.slice(0, source.lastIndexOf('\nmain().catch'));
const managed = 'http://localhost:10000';
const system = 'http://localhost:13305';
const catalog = [
  { id: 'Local-Chat', downloaded: true, labels: ['chat', 'tool-calling'] },
  { id: 'Tiny-Test-Model-GGUF', downloaded: false, labels: ['chat'], size: 0.18 },
  { id: 'Large-Chat', downloaded: false, labels: ['chat'], size: 4 },
  { id: 'Small-Chat', downloaded: false, labels: ['chat'], size: 1 },
];

function fixture(t, scenes = ['s7'], overrides = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chanh-demo-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const servers = new Map();
  const events = [];
  const binDir = path.join(workspace, '.vscode-user-data', 'User', 'globalStorage',
    'lanly-dev.chanh', 'bin', 'lemonade-server');
  const install = () => {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, process.platform === 'win32' ? 'lemond.exe' : 'lemond'), 'binary');
    fs.writeFileSync(path.join(binDir, '.version'), '1.0.0');
  };
  const context = vm.createContext({
    require: name => name === 'playwright' ? {} : require(name),
    __dirname,
    process: {
      argv: ['node', 'demo.js', ...scenes],
      env: { DEMO_WORKSPACE: workspace, DEMO_CODE_PATH: '/fake/code', DEMO_CHANH_REPO: '/fake/repo', ...overrides },
      platform: process.platform,
    },
    console: { log() {}, error() {} },
    fetch: async url => {
      events.push(url);
      const base = new URL(url).origin;
      const models = servers.get(base);
      return { ok: !!models, json: async () => ({ data: models }) };
    },
    command: async title => {
      events.push(title);
      if (title === 'Chanh: Download/Update Binary') install();
      if (title === 'Chanh: Start Server') {
        assert.ok(fs.existsSync(path.join(binDir, '.version')));
        servers.set(managed, catalog);
      }
    },
  });
  vm.runInContext(`${driver}
    ensureFfmpeg = async () => {};
    palette = command;
    pollUntil = async (check, what) => {
      for (let i = 0; i < 5; i++) if (await check()) return;
      throw new Error('Still waiting for ' + what);
    };
    win = {
      locator: () => ({ first: () => ({ isVisible: async () => true, click: async () => {} }) }),
      waitForTimeout: async () => {},
    };
    openFileQuick = async () => { throw new Error('model selected; stop before recording'); };
    globalThis.demo = {
      CONFIG, SETTINGS, preflight, discoverModels, s7,
      getBase: () => discoveryBase,
      installComplete,
    };
  `, context);
  return {
    ...context.demo, servers, events, workspace, install,
    settings: () => JSON.parse(fs.readFileSync(path.join(workspace, '.vscode-user-data', 'User', 'settings.json'))),
  };
}

test('clean Scene 7 installs and starts the managed server before discovery and selection', async t => {
  const demo = fixture(t);
  await demo.preflight();
  assert.equal(demo.installComplete(), false);
  assert.equal(demo.settings()['chanh.serverMode'], 'LEMOND');
  assert.ok(!demo.events.some(event => event.includes('/v1/models')));
  demo.events.length = 0;
  await assert.rejects(demo.s7(), /model selected; stop before recording/);
  assert.deepEqual(demo.events, [
    `${managed}/v1/health`,
    'Chanh: Download/Update Binary',
    'Chanh: Start Server',
    `${managed}/v1/health`,
    `${managed}/v1/models?show_all=true`,
    'Chanh: Select Chat Model',
  ]);
  assert.equal(demo.CONFIG.chatModel, 'Local-Chat');
  assert.equal(demo.CONFIG.toolModel, 'Local-Chat');
  assert.equal(demo.CONFIG.downloadModel, 'Small-Chat');
});

test('an installed binary is reused when Scene 7 starts a stopped server', async t => {
  const demo = fixture(t, ['s7', '--keep-state']);
  demo.install();
  await demo.preflight();
  demo.events.length = 0;
  await assert.rejects(demo.s7(), /model selected; stop before recording/);
  assert.ok(demo.events.includes('Chanh: Start Server'));
  assert.ok(!demo.events.includes('Chanh: Download/Update Binary'));
});

test('preflight prefers the managed endpoint and writes it into the profile', async t => {
  const demo = fixture(t);
  demo.servers.set(managed, catalog);
  demo.servers.set(system, [{ id: 'Other-Chat', downloaded: true, labels: ['chat'] }]);
  await demo.preflight();
  assert.equal(demo.getBase(), managed);
  assert.equal(demo.settings()['chanh.serverMode'], 'LEMOND');
  assert.equal(demo.CONFIG.chatModel, 'Local-Chat');
  assert.ok(!demo.events.some(event => event.startsWith(system)));
  demo.events.length = 0;
  await assert.rejects(demo.s7(), /model selected; stop before recording/);
  assert.deepEqual(demo.events, [`${managed}/v1/health`, 'Chanh: Select Chat Model']);
});

for (const overrides of [{}, {
  DEMO_CHAT_MODEL: 'Forced-Chat', DEMO_TOOL_MODEL: 'Forced-Tool', DEMO_DOWNLOAD_MODEL: 'Forced-Download',
}]) {
  test(`system fallback is written before launch and preserves overrides (${Object.keys(overrides).length})`, async t => {
    const demo = fixture(t, ['s7'], overrides);
    demo.servers.set(system, catalog);
    await demo.preflight();
    const settings = demo.settings();
    assert.equal(demo.getBase(), system);
    assert.equal(settings['chanh.serverMode'], 'LEMONADE');
    assert.equal(settings['chanh.lemonadePort'], 13305);
    assert.equal(demo.CONFIG.chatModel, overrides.DEMO_CHAT_MODEL || 'Local-Chat');
    assert.equal(demo.CONFIG.toolModel, overrides.DEMO_TOOL_MODEL || 'Local-Chat');
    assert.equal(demo.CONFIG.downloadModel, overrides.DEMO_DOWNLOAD_MODEL || 'Small-Chat');
    demo.events.length = 0;
    await assert.rejects(demo.s7(), /model selected; stop before recording/);
    assert.deepEqual(demo.events, [`${system}/v1/health`, 'Chanh: Select Chat Model']);
  });
}

test('Scene 2 keeps LEMOND and discovers only from its server after startup', async t => {
  const demo = fixture(t, ['s2', 's7', '--keep-state']);
  demo.install();
  demo.servers.set(system, catalog);
  await demo.preflight();
  assert.equal(demo.installComplete(), false);
  assert.equal(demo.settings()['chanh.serverMode'], 'LEMOND');
  await demo.discoverModels();
  assert.equal(demo.CONFIG.chatModel, '');
  demo.servers.set(managed, catalog);
  await demo.discoverModels();
  assert.equal(demo.getBase(), managed);
  assert.equal(demo.CONFIG.chatModel, 'Local-Chat');
  assert.ok(!demo.events.some(event => event.startsWith(system)));
});

test('a preflight miss pins later discovery to the profile endpoint', async t => {
  const demo = fixture(t);
  await demo.preflight();
  demo.events.length = 0;
  demo.servers.set(system, catalog);
  await demo.discoverModels();
  assert.equal(demo.CONFIG.chatModel, '');
  assert.deepEqual(demo.events, [`${managed}/v1/models?show_all=true`]);
  demo.servers.set(managed, catalog);
  await demo.discoverModels();
  assert.equal(demo.CONFIG.chatModel, 'Local-Chat');
});
