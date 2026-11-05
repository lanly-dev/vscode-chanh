const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

// The helpers under test are TypeScript with no VS Code imports. Load them
// by transpiling the single file with the repo's own typescript package;
// fall back to Node's native type stripping when that is unavailable.
function loadHelpers() {
  const sourcePath = path.join(__dirname, '..', 'src', 'completionText.ts')
  try {
    const ts = require('typescript')
    const source = fs.readFileSync(sourcePath, 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    })
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chanh-completion-test-')), 'completionText.cjs')
    fs.writeFileSync(tmp, outputText)
    return require(tmp)
  } catch {
    return require(sourcePath)
  }
}

const { cleanCompletion, stripCodeFences, pickCompletionModel } = loadHelpers()

test('stripCodeFences removes a wrapping fence with a language tag', () => {
  assert.equal(stripCodeFences('```ts\nconst a = 1\n```'), 'const a = 1')
})

test('stripCodeFences removes a bare fence', () => {
  assert.equal(stripCodeFences('```\nreturn 42\n```'), 'return 42')
})

test('stripCodeFences leaves unfenced text untouched', () => {
  assert.equal(stripCodeFences('const a = 1'), 'const a = 1')
})

test('cleanCompletion passes plain code through', () => {
  assert.equal(cleanCompletion('return x + 1', '  ', '  '), 'return x + 1')
})

test('cleanCompletion strips fences from the model response', () => {
  assert.equal(cleanCompletion('```js\nconst a = 1\n```', '', ''), 'const a = 1')
})

test('cleanCompletion drops a duplicated first line when more follows', () => {
  const raw = 'function main() {\n  greet()\n}'
  assert.equal(cleanCompletion(raw, 'function main() {', 'function main() {'), '  greet()\n}')
})

test('cleanCompletion cuts the already-typed prefix of a restarted line', () => {
  assert.equal(cleanCompletion('const x = compute()', 'const x = ', 'const x = '), 'compute()')
})

test('cleanCompletion returns undefined when the model only echoes the line', () => {
  assert.equal(cleanCompletion('const x = 1', 'const x', 'const x = 1'), undefined)
})

test('cleanCompletion returns undefined for whitespace-only responses', () => {
  assert.equal(cleanCompletion('  \n  ', 'x', 'x'), undefined)
})

test('cleanCompletion returns undefined for empty responses', () => {
  assert.equal(cleanCompletion('', '', ''), undefined)
})

test('cleanCompletion returns undefined when only a fence remains', () => {
  assert.equal(cleanCompletion('```\n```', '', ''), undefined)
})

test('cleanCompletion trims trailing blank lines but keeps inner structure', () => {
  assert.equal(cleanCompletion('a()\n\nb()\n\n\n', '', ''), 'a()\n\nb()')
})

test('pickCompletionModel prefers a configured loaded model over an earlier loaded one', () => {
  // A is first in server order and loaded, but the configured B wins.
  const pick = pickCompletionModel(['B'], ['A', 'B'], new Set(['A', 'B']))
  assert.deepEqual(pick, { model: 'B', source: 'configured' })
})

test('pickCompletionModel honors configured priority order', () => {
  // X is configured first but not loaded; Y (second) is usable.
  const pick = pickCompletionModel(['X', 'Y'], ['X', 'Y'], new Set(['Y']))
  assert.deepEqual(pick, { model: 'Y', source: 'configured' })
})

test('pickCompletionModel falls back to a loaded chat model when the configured one is not loaded', () => {
  const pick = pickCompletionModel(['X'], ['X', 'A'], new Set(['A']))
  assert.deepEqual(pick, { model: 'A', source: 'fallback' })
})

test('pickCompletionModel with nothing configured picks the first loaded chat model', () => {
  const pick = pickCompletionModel([], ['A', 'B'], new Set(['B']))
  assert.deepEqual(pick, { model: 'B', source: 'fallback' })
})

test('pickCompletionModel falls back when the configured model is not chat-capable', () => {
  // V is loaded but has no chat capability; it must not serve, A does.
  const pick = pickCompletionModel(['V'], ['A'], new Set(['V', 'A']))
  assert.deepEqual(pick, { model: 'A', source: 'fallback' })
})

test('pickCompletionModel never picks a loaded model that is not chat-capable', () => {
  const pick = pickCompletionModel([], ['A'], new Set(['Z']))
  assert.deepEqual(pick, { model: undefined, source: 'none' })
})

test('pickCompletionModel returns no pick when nothing chat-capable is loaded', () => {
  assert.deepEqual(
    pickCompletionModel(['X'], ['X', 'A'], new Set()),
    { model: undefined, source: 'none' })
  assert.deepEqual(
    pickCompletionModel([], ['A'], new Set()),
    { model: undefined, source: 'none' })
})
