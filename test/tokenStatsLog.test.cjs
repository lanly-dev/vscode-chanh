const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { buildSync } = require('esbuild')

const source = buildSync({
  entryPoints: [path.join(__dirname, '../src/tokenStatsLog.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false
}).outputFiles[0].text

// Load the bundle once with a stubbed `vscode` module; the panel stub
// captures the last HTML handed to createWebviewPanel.
function loadModule() {
  const captured = { html: undefined }
  const window = {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    createWebviewPanel: () => ({
      webview: {
        set html(value) { captured.html = value },
        get html() { return captured.html }
      }
    })
  }
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: name => name === 'vscode' ? { window, ViewColumn: { Active: 1 } } : require(name),
    console
  })
  return { api: module.exports, captured }
}

// Objects returned from the vm realm carry its prototypes, which
// deepStrictEqual rejects; round-trip them into this realm before comparing.
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function record(ts, model, source, promptTokens, completionTokens) {
  return {
    ts, model, source,
    promptTokens, completionTokens, totalTokens: promptTokens + completionTokens
  }
}

// Local-time ISO strings so the today/older split is timezone-stable.
function localIso(year, month, day, hour) {
  return new Date(year, month, day, hour).toISOString()
}

test('parseTokenUsageLog keeps valid records and skips corrupt lines', () => {
  const { api } = loadModule()
  const good1 = record(localIso(2026, 9, 28, 9), 'model-a', 'chat', 100, 20)
  const good2 = record(localIso(2026, 9, 28, 10), 'model-b', 'agent', 50, 50)
  const text = [
    JSON.stringify(good1),
    '{"ts":"2026-10-28T10:00:00.000Z","model":"model-b","sou', // torn final write
    'not json at all',
    JSON.stringify({ ts: 'x', model: 'm', source: 'chat', promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
    JSON.stringify({ ts: good1.ts, model: 'm', source: 'other', promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
    JSON.stringify({ ts: good1.ts, model: 'm', source: 'chat', promptTokens: '1', completionTokens: 2, totalTokens: 3 }),
    '',
    JSON.stringify(good2)
  ].join('\n')
  assert.deepEqual(plain(api.parseTokenUsageLog(text)), [good1, good2])
  assert.deepEqual(plain(api.parseTokenUsageLog('')), [])
})

test('summarizeTokenUsage splits today vs all time and totals per model', () => {
  const { api } = loadModule()
  const now = new Date(2026, 9, 28, 15)
  const records = [
    record(localIso(2026, 9, 28, 9), 'model-a', 'chat', 100, 20),
    record(localIso(2026, 9, 28, 11), 'model-a', 'agent', 200, 40),
    record(localIso(2026, 9, 28, 12), 'model-b', 'chat', 1000, 500),
    record(localIso(2026, 9, 27, 23), 'model-a', 'chat', 10, 5),
    record(localIso(2026, 9, 20, 12), 'model-c', 'agent', 7, 3)
  ]
  const summary = api.summarizeTokenUsage(records, now)

  assert.equal(summary.today.turns, 3)
  assert.equal(summary.today.promptTokens, 1300)
  assert.equal(summary.today.completionTokens, 560)
  assert.equal(summary.today.totalTokens, 1860)
  // Busiest model first.
  assert.deepEqual(plain(summary.today.perModel.map(m => m.model)), ['model-b', 'model-a'])
  assert.deepEqual(plain(summary.today.perModel[1]),
    { model: 'model-a', turns: 2, promptTokens: 300, completionTokens: 60, totalTokens: 360 })

  assert.equal(summary.allTime.turns, 5)
  assert.equal(summary.allTime.totalTokens, 1885)
  assert.deepEqual(plain(summary.allTime.perModel.map(m => m.model)), ['model-b', 'model-a', 'model-c'])

  const empty = api.summarizeTokenUsage([], now)
  assert.equal(empty.today.turns, 0)
  assert.deepEqual(plain(empty.allTime.perModel), [])
})

test('recordTokenUsage appends complete-usage turns and survives a corrupt line', (t) => {
  const { api } = loadModule()
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'chanh-token-stats-'))
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }))
  api.initTokenStatsLog({ globalStorageUri: { fsPath: storage } })

  const stats = { promptTokens: 120, completionTokens: 30, totalTokens: 150 }
  api.recordTokenUsage('model-a', 'chat', stats)
  // A turn whose server usage block was incomplete is never logged.
  api.recordTokenUsage('model-a', 'chat', { promptTokens: 5, completionTokens: 5 })
  api.recordTokenUsage('model-b', 'agent', { promptTokens: 1, completionTokens: 2, totalTokens: 3 })

  const logFile = path.join(storage, 'token-usage.jsonl')
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)

  // A torn line in the middle of the file must not break later reads.
  fs.appendFileSync(logFile, '{"ts":"2026-10-28T12:00:00.000Z","model":"brok\n')
  const records = api.loadTokenUsageRecords()
  assert.equal(records.length, 2)
  assert.equal(records[0].model, 'model-a')
  assert.equal(records[0].source, 'chat')
  assert.equal(records[0].totalTokens, 150)
  assert.equal(records[1].source, 'agent')
})

test('recordTokenUsage before init is a no-op, and the empty summary renders', async (t) => {
  const { api, captured } = loadModule()
  assert.doesNotThrow(() =>
    api.recordTokenUsage('model-a', 'chat', { promptTokens: 1, completionTokens: 1, totalTokens: 2 }))

  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'chanh-token-stats-'))
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }))
  api.initTokenStatsLog({ globalStorageUri: { fsPath: storage } })
  assert.deepEqual(plain(api.loadTokenUsageRecords()), [])

  await api.showTokenUsage()
  assert.match(captured.html, /Token Usage/)
  assert.match(captured.html, /No token usage recorded yet/)
})

test('showTokenUsage renders per-model rows and totals', async (t) => {
  const { api, captured } = loadModule()
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'chanh-token-stats-'))
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }))
  api.initTokenStatsLog({ globalStorageUri: { fsPath: storage } })
  api.recordTokenUsage('Qwen-Test-GGUF', 'agent', { promptTokens: 20411, completionTokens: 91, totalTokens: 20502 })

  await api.showTokenUsage()
  assert.match(captured.html, /Qwen-Test-GGUF/)
  assert.match(captured.html, /20,502/)
  assert.match(captured.html, /All models/)
})
