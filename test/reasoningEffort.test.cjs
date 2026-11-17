const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

// The helpers under test are TypeScript with no VS Code imports. Load them
// by transpiling the single file with the repo's own typescript package;
// fall back to Node's native type stripping when that is unavailable.
function loadHelpers() {
  const sourcePath = path.join(__dirname, '..', 'src', 'reasoningEffort.ts')
  try {
    const ts = require('typescript')
    const source = fs.readFileSync(sourcePath, 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    })
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chanh-reasoning-test-')), 'reasoningEffort.cjs')
    fs.writeFileSync(tmp, outputText)
    return require(tmp)
  } catch {
    return require(sourcePath)
  }
}

const { resolveReasoningLevels, buildReasoningConfigurationSchema, resolveReasoningEffort } = loadHelpers()

const DEFAULT_MAP = { '*': ['none', 'low', 'medium', 'high'] }

test('resolveReasoningLevels: substring key match returns its levels', () => {
  const map = { qwen3: ['low', 'high'] }
  assert.deepEqual(resolveReasoningLevels('Qwen3-32B-GGUF', ['chat'], map), ['low', 'high'])
})

test('resolveReasoningLevels: substring matching is case-insensitive on both sides', () => {
  const map = { QWEN: ['low'] }
  assert.deepEqual(resolveReasoningLevels('qwen3-4b-gguf', undefined, map), ['low'])
})

test('resolveReasoningLevels: substring match applies without the reasoning label', () => {
  const map = { 'gpt-oss': ['low', 'medium', 'high'] }
  assert.deepEqual(resolveReasoningLevels('gpt-oss-20b', ['chat'], map), ['low', 'medium', 'high'])
})

test('resolveReasoningLevels: a specific key beats the * fallback', () => {
  const map = { '*': ['none'], deepseek: ['low', 'high'] }
  assert.deepEqual(resolveReasoningLevels('DeepSeek-R1-GGUF', ['reasoning'], map), ['low', 'high'])
})

test('resolveReasoningLevels: * fallback applies to reasoning-labelled models', () => {
  assert.deepEqual(
    resolveReasoningLevels('DeepSeek-R1-GGUF', ['chat', 'reasoning'], DEFAULT_MAP),
    ['none', 'low', 'medium', 'high']
  )
})

test('resolveReasoningLevels: * fallback does not apply without the reasoning label', () => {
  assert.equal(resolveReasoningLevels('Qwen3-Coder-GGUF', ['chat', 'tool-calling'], DEFAULT_MAP), undefined)
})

test('resolveReasoningLevels: the reasoning label match is case-insensitive', () => {
  assert.deepEqual(resolveReasoningLevels('SomeModel', ['Reasoning'], DEFAULT_MAP), DEFAULT_MAP['*'])
})

test('resolveReasoningLevels: an empty list for a matched key disables the picker', () => {
  const map = { '*': ['low'], qwen: [] }
  assert.equal(resolveReasoningLevels('Qwen3-GGUF', ['reasoning'], map), undefined)
})

test('resolveReasoningLevels: an empty * list disables the picker for reasoning models', () => {
  assert.equal(resolveReasoningLevels('DeepSeek-R1', ['reasoning'], { '*': [] }), undefined)
})

test('resolveReasoningLevels: no match and no * entry means no picker', () => {
  assert.equal(resolveReasoningLevels('Qwen3-GGUF', ['reasoning'], { llama: ['low'] }), undefined)
  assert.equal(resolveReasoningLevels('Qwen3-GGUF', ['reasoning'], {}), undefined)
  assert.equal(resolveReasoningLevels('Qwen3-GGUF', undefined, {}), undefined)
})

test('resolveReasoningLevels: a non-array map value is ignored', () => {
  const map = { '*': 'high' }
  assert.equal(resolveReasoningLevels('DeepSeek-R1', ['reasoning'], map), undefined)
})

test('buildReasoningConfigurationSchema: shape, enum, and labels', () => {
  const schema = buildReasoningConfigurationSchema(['none', 'low', 'medium', 'high'])
  const prop = schema.properties.reasoningEffort
  assert.equal(prop.type, 'string')
  assert.equal(prop.title, 'Reasoning')
  assert.equal(prop.group, 'navigation')
  assert.deepEqual(prop.enum, ['none', 'low', 'medium', 'high'])
  assert.deepEqual(prop.enumItemLabels, ['None', 'Low', 'Medium', 'High'])
})

test('buildReasoningConfigurationSchema: defaults to medium when offered', () => {
  const schema = buildReasoningConfigurationSchema(['low', 'medium', 'high'])
  assert.equal(schema.properties.reasoningEffort.default, 'medium')
})

test('buildReasoningConfigurationSchema: defaults to the first level without medium', () => {
  const schema = buildReasoningConfigurationSchema(['low', 'high'])
  assert.equal(schema.properties.reasoningEffort.default, 'low')
})

test('buildReasoningConfigurationSchema: unknown levels label themselves', () => {
  const schema = buildReasoningConfigurationSchema(['minimal', 'medium'])
  assert.deepEqual(schema.properties.reasoningEffort.enumItemLabels, ['minimal', 'Medium'])
})

test('resolveReasoningEffort: the picker value wins over the setting', () => {
  assert.equal(resolveReasoningEffort('high', 'low'), 'high')
})

test('resolveReasoningEffort: the setting applies when the picker is unset', () => {
  assert.equal(resolveReasoningEffort(undefined, 'low'), 'low')
  assert.equal(resolveReasoningEffort('', 'medium'), 'medium')
  assert.equal(resolveReasoningEffort(42, 'medium'), 'medium')
})

test('resolveReasoningEffort: nothing configured resolves to undefined', () => {
  assert.equal(resolveReasoningEffort(undefined, ''), undefined)
  assert.equal(resolveReasoningEffort(undefined, undefined), undefined)
  assert.equal(resolveReasoningEffort('', ''), undefined)
})
