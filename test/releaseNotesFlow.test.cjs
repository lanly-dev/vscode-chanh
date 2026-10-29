const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { promisify } = require('node:util')
const vm = require('node:vm')
const ts = require('typescript')

// Load the real command and participant with only their host dependencies mocked.
function loadSource(name, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', `${name}.ts`), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const m = { exports: {} }
  vm.runInNewContext(outputText, {
    module: m, exports: m.exports, Error, AbortController,
    require: (id) => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id)
  })
  return m.exports
}
const core = loadSource('releaseNotesCore')
const originalChangelog = '# Change Log\r\n\r\n## [0.1.4]\r\n- Old entry\r\n'
const originalReadme = '# Chanh\r\n\r\n## Release Notes\r\n\r\n### 0.1.4\r\n- Old entry\r\n'

function commandFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chanh-release-notes-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const changelogPath = path.join(root, 'CHANGELOG.md')
  const readmePath = path.join(root, 'README.md')
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.1.5"}')
  fs.writeFileSync(changelogPath, options.changelog ?? originalChangelog)
  fs.writeFileSync(readmePath, originalReadme)
  const errors = []
  const logs = []
  const opened = []
  const operations = []
  const listeners = new Set()
  const state = { disposed: 0, cancelled: options.cancelled ?? false }
  function cancel() {
    state.cancelled = true
    for (const listener of listeners) listener()
  }
  const fileSystem = { ...fs }
  for (const method of ['readFileSync', 'writeFileSync', 'renameSync', 'rmSync']) {
    fileSystem[method] = (...args) => {
      operations.push({ method, args })
      options.failIO?.(method, ...args)
      return fs[method](...args)
    }
  }
  const execFile = () => {}
  execFile[promisify.custom] = async (_command, args) => {
    if (options.gitError !== undefined) throw options.gitError
    const stdout = args[1] === '--format=%s' ? 'feat: add a feature\n' : ''
    return { stdout }
  }
  class Position {
    constructor(line) {
      this.line = line
    }
  }
  const host = {
    ProgressLocation: { Notification: 1 },
    TextEditorRevealType: { AtTop: 1 },
    Position, Selection: Position, Range: Position,
    Uri: { file: (file) => ({ fsPath: file }) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }],
      openTextDocument: async (document) => {
        opened.push(document)
        return document
      }
    },
    window: {
      showErrorMessage: (message) => errors.push(message),
      showWarningMessage: () => {},
      showInformationMessage: () => {},
      showTextDocument: async () => ({ revealRange() {} }),
      withProgress: async (config, callback) => {
        state.progressOptions = config
        return callback({}, {
          get isCancellationRequested() {
            return state.cancelled
          },
          onCancellationRequested(listener) {
            listeners.add(listener)
            return { dispose() {
              listeners.delete(listener)
              state.disposed++
            } }
          }
        })
      }
    }
  }
  const { draftReleaseNotes } = loadSource('releaseNotes', {
    fs: fileSystem, child_process: { execFile }, vscode: host,
    './interfaces': { ServerStatus: { RUNNING: 'running' } },
    './logger': { Logger: { error: (...args) => logs.push(args), info() {} } },
    './releaseNotesCore': core
  })
  return {
    root, changelogPath, readmePath, errors, logs, opened, operations, state,
    run: () => draftReleaseNotes({ status: 'running' }, {
      completeWithChatModel: async (_messages, signal) => {
        state.signal = signal
        return options.complete ? options.complete({ signal, cancel }) : '- Add a feature'
      }
    }),
    assertUnchanged() {
      assert.equal(fs.readFileSync(changelogPath, 'utf8'), options.changelog ?? originalChangelog)
      assert.equal(fs.readFileSync(readmePath, 'utf8'), originalReadme)
      assert.deepEqual(fs.readdirSync(root).sort(), ['CHANGELOG.md', 'README.md', 'package.json'])
    }
  }
}

for (const gitError of [new Error('git is unavailable'), 'not a repository']) {
  test(`git failures include their message and change no documents: ${gitError}`, async (t) => {
    const fixture = commandFixture(t, { gitError })
    await fixture.run()
    assert.match(fixture.errors[0], /Could not read the git history:/)
    assert.ok(fixture.errors[0].includes(gitError.message ?? gitError))
    assert.ok(fixture.errors[0].endsWith('No files were changed.'))
    assert.equal(fixture.logs.length, 1)
    assert.equal(fixture.state.signal, undefined)
    fixture.assertUnchanged()
  })
}

test('successful drafts atomically replace both documents and dispose cancellation', async (t) => {
  const fixture = commandFixture(t)
  await fixture.run()
  assert.equal(fixture.errors.length, 0)
  assert.equal(fixture.state.progressOptions.cancellable, true)
  assert.equal(fixture.state.disposed, 1)
  for (const target of [fixture.changelogPath, fixture.readmePath]) {
    const content = fs.readFileSync(target, 'utf8')
    assert.ok(content.includes('- Add a feature\r\n'))
    assert.equal(content.replaceAll('\r\n', '').includes('\n'), false)
    const rename = fixture.operations.find(({ method, args }) => method === 'renameSync' && args[1] === target)
    assert.ok(rename)
    assert.equal(path.dirname(rename.args[0]), path.dirname(target))
    assert.ok(fixture.operations.some(({ method, args }) => method === 'writeFileSync' && args[0] === rename.args[0]))
    assert.equal(fixture.operations.some(({ method, args }) => method === 'writeFileSync' && args[0] === target), false)
  }
  assert.deepEqual(fs.readdirSync(fixture.root).sort(), ['CHANGELOG.md', 'README.md', 'package.json'])
})

for (const complete of [
  () => {
    throw new Error('model failed')
  },
  ({ signal, cancel }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true })
    cancel()
  }),
  ({ cancel }) => {
    cancel()
    return '- Partial draft'
  }
]) {
  test('failed or cancelled drafts dispose the listener and change no documents', async (t) => {
    const fixture = commandFixture(t, { complete })
    await fixture.run()
    assert.equal(fixture.state.disposed, 1)
    assert.equal(fixture.errors.length, 1)
    fixture.assertUnchanged()
  })
}

test('already cancelled progress passes an aborted signal and changes no documents', async (t) => {
  const fixture = commandFixture(t, { cancelled: true })
  await fixture.run()
  assert.equal(fixture.state.signal.aborted, true)
  assert.equal(fixture.state.disposed, 1)
  fixture.assertUnchanged()
})

for (const filename of ['CHANGELOG.md', 'README.md']) {
  test(`read failures in ${filename} are reported before any writes`, async (t) => {
    const fixture = commandFixture(t, {
      failIO(method, file) {
        if (method === 'readFileSync' && path.basename(file) === filename) throw new Error(`${filename}: EACCES`)
      }
    })
    await fixture.run()
    assert.match(fixture.errors[0], /Could not read release-note files: .*EACCES/)
    assert.equal(fixture.operations.some(({ method }) => method === 'writeFileSync'), false)
    fixture.assertUnchanged()
  })
  for (const failure of ['writeFileSync', 'renameSync']) {
    test(`${failure} failure for ${filename} leaves both documents intact`, async (t) => {
      const fixture = commandFixture(t, {
        failIO(method, source, destination) {
          if (method !== failure) return
          const matches = method === 'renameSync'
            ? path.basename(destination) === filename : path.basename(source).includes(filename)
          if (matches) {
            if (method === 'writeFileSync') fs.writeFileSync(source, 'partial write')
            throw new Error(`${filename}: ENOSPC`)
          }
        }
      })
      await fixture.run()
      assert.match(fixture.errors[0], /Could not update release-note files: .*ENOSPC/)
      assert.equal(fixture.opened.length, 0)
      fixture.assertUnchanged()
    })
  }
}

test('rollback failure is logged and tells the user to restore the changelog', async (t) => {
  let replacements = 0
  const fixture = commandFixture(t, {
    failIO(method) {
      if (method === 'renameSync' && ++replacements >= 2) throw new Error('rename denied')
    }
  })
  await fixture.run()
  assert.match(fixture.errors[0], /Could not restore CHANGELOG.md: rename denied/)
  assert.equal(fixture.logs.length, 2)
  assert.equal(fs.readFileSync(fixture.readmePath, 'utf8'), originalReadme)
})

test('populated release sections open a draft without modifying either document', async (t) => {
  const fixture = commandFixture(t, { changelog: originalChangelog.replace('0.1.4', '0.1.5') })
  await fixture.run()
  assert.equal(fixture.errors.length, 0)
  assert.equal(fixture.opened.length, 1)
  assert.equal(fixture.opened[0].language, 'markdown')
  fixture.assertUnchanged()
})

const { ChatParticipant } = loadSource('chatParticipant', {
  vscode: {}, './lemonadeClient': {}, './logger': {}, './utils': {},
  './interfaces': {}, './modelManager': {}, './serverManager': {}
})

test('completeWithChatModel forwards its signal to the streaming request', async () => {
  const controller = new AbortController()
  const messages = [{ role: 'user', content: 'Draft release notes' }]
  const participant = Object.create(ChatParticipant.prototype)
  participant.getModel = async () => 'test-model'
  let expectedSignal = controller.signal
  participant.client = {
    chatCompletionStream: async (request, _onToken, signal) => {
      assert.equal(request.model, 'test-model')
      assert.equal(request.messages, messages)
      assert.equal(signal, expectedSignal)
      return '- Add a feature'
    }
  }
  assert.equal(await participant.completeWithChatModel(messages, controller.signal), '- Add a feature')
  expectedSignal = undefined
  assert.equal(await participant.completeWithChatModel(messages), '- Add a feature')
})

for (const cancelBeforeSelection of [true, false]) {
  test('cancellation during model selection prevents a streaming request', async () => {
    const controller = new AbortController()
    const participant = Object.create(ChatParticipant.prototype)
    participant.getModel = async () => {
      controller.abort()
      return 'test-model'
    }
    participant.client = { chatCompletionStream() {
      assert.fail('must not stream after cancellation')
    } }
    if (cancelBeforeSelection) controller.abort()
    await assert.rejects(participant.completeWithChatModel([], controller.signal), { name: 'AbortError' })
  })
}

for (const eol of ['\n', '\r\n']) {
  for (const [name, apply, fixture, oldHeading, emptyHeading] of [
    ['changelog', (text) => core.insertChangelogSection(text, '0.1.5', '2026-10-29', ['- Add thing']),
      originalChangelog, '## [0.1.4]', '## [0.1.5] -\n\n'],
    ['readme', (text) => core.applyReadmeSection(text, '0.1.5', ['- Add thing']),
      originalReadme, '### 0.1.4', '### 0.1.5\n\n']
  ]) {
    const lfFixture = fixture.replaceAll('\r\n', '\n')
    for (const [scenario, input, outcome] of [
      ['insert before older sections', lfFixture, 'inserted'],
      ['fill an empty section', lfFixture.replace(oldHeading, emptyHeading + oldHeading), 'filled'],
      ['append without older sections', '# Document\n', 'inserted']
    ]) {
      test(`${name}: ${scenario} preserves ${JSON.stringify(eol)} line endings`, () => {
        const source = input.replaceAll('\n', eol)
        const actual = apply(source)
        const expected = apply(input)
        assert.equal(actual.outcome, outcome)
        assert.equal(actual.content, expected.content.replaceAll('\n', eol))
      })
    }
    test(`${name}: populated ${JSON.stringify(eol)} sections stay byte-for-byte unchanged`, () => {
      const source = lfFixture.replace(oldHeading, emptyHeading + '- Keep this\n\n' + oldHeading).replaceAll('\n', eol)
      assert.equal(apply(source).outcome, 'exists')
      assert.equal(apply(source).content, source)
    })
  }
}
