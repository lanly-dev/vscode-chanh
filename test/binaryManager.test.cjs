const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { buildSync } = require('esbuild')

const source = buildSync({
  entryPoints: [path.join(__dirname, '../src/binaryManager.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false
}).outputFiles[0].text

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fixture(t, platform = 'linux') {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'chanh-binary-test-'))
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }))
  const prompts = []
  const window = {
    createOutputChannel: () => ({ appendLine() {} }),
    showErrorMessage: async () => undefined,
    showInformationMessage: async (message, ...actions) => {
      if (actions.includes('Download')) {
        prompts.push(message)
        return 'Cancel'
      }
    },
    withProgress: async (_, run) => run({ report() {} }, {})
  }
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: name => name === 'vscode' ? { window, ProgressLocation: { Notification: 15 } } : require(name),
    process: { platform, arch: 'x64' }
  })
  const manager = new module.exports.BinaryManager({ globalStorageUri: { fsPath: storage } })
  const assetName = manager.getAssetName('1.0.0')
  let downloads = 0
  manager.getLatestRelease = async () => ({
    tag_name: 'v1.0.0',
    assets: [{ name: assetName, size: 1, browser_download_url: 'https://example.invalid/archive' }]
  })
  manager.downloadFile = async (_, archive) => {
    downloads++
    fs.writeFileSync(archive, 'archive')
  }
  const extract = async () => writeDeployment(manager)
  manager.extractZip = extract
  manager.extractTarGz = extract
  return { manager, window, prompts, downloads: () => downloads, BinaryManager: module.exports.BinaryManager, storage }
}

function writeDeployment(manager, nested = false, resources = true) {
  const dir = nested ? path.join(manager.binaryDir, 'deployment') : manager.binaryDir
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, path.basename(manager.binaryPath)), 'executable')
  if (resources) {
    fs.mkdirSync(path.join(dir, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'resources', 'models.json'), '{}')
  }
}

for (const platform of ['linux', 'win32']) {
  test(`${platform}: concurrent downloads and a pending start prompt await the full install`, async t => {
    const { manager, window, downloads } = fixture(t, platform)
    const prompt = deferred()
    window.showInformationMessage = (_, ...actions) => actions.includes('Download') ? prompt.promise : Promise.resolve()
    const extracting = deferred()
    const finish = deferred()
    const extract = async () => {
      writeDeployment(manager, true, false)
      extracting.resolve()
      await finish.promise
      writeDeployment(manager, true)
    }
    manager.extractZip = extract
    manager.extractTarGz = extract

    let started = false
    const start = manager.ensureBinary().then(result => {
      started = result
      return result
    })
    const install = manager.downloadBinary()
    await extracting.promise
    let waitingStartDone = false
    const waitingStart = manager.ensureBinary().then(result => {
      waitingStartDone = true
      return result
    })
    let duplicateDone = false
    const duplicate = manager.downloadBinary().then(() => {
      duplicateDone = true
    })
    prompt.resolve('Download')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(manager.isInstalling, true)
    assert.equal(started, false)
    assert.equal(duplicateDone, false)
    assert.equal(waitingStartDone, false)
    assert.equal(downloads(), 1)

    finish.resolve()
    assert.equal(await start, true)
    assert.equal(await waitingStart, true)
    await Promise.all([install, duplicate])
    assert.equal(manager.isInstalling, false)
    assert.equal(fs.existsSync(path.join(manager.binaryDir, 'resources', 'models.json')), true)
    assert.equal(downloads(), 1)
  })

  test(`${platform}: failed extraction stays unusable across restarts and can be retried`, async t => {
    const { manager, window, prompts, downloads, BinaryManager, storage } = fixture(t, platform)
    fs.mkdirSync(manager.binaryDir, { recursive: true })
    const config = path.join(manager.binaryDir, 'config.json')
    fs.writeFileSync(config, '{"custom":true}')
    const extracting = deferred()
    const finish = deferred()
    const extract = async () => {
      writeDeployment(manager, true)
      writeDeployment(manager)
      fs.writeFileSync(path.join(manager.binaryDir, 'resources', 'models.json'), 'incomplete')
      extracting.resolve()
      await finish.promise
      throw new Error('extraction failed after writing some resources')
    }
    manager.extractZip = extract
    manager.extractTarGz = extract
    const install = manager.downloadBinary()
    await extracting.promise
    const start = manager.ensureBinary()
    finish.resolve()
    await install
    assert.equal(await start, false)
    assert.equal(prompts.length, 1)
    assert.equal(manager.isBinaryInstalled(), false)
    const restarted = new BinaryManager({ globalStorageUri: { fsPath: storage } })
    assert.equal(restarted.isBinaryInstalled(), false)
    assert.equal(fs.readFileSync(config, 'utf8'), '{"custom":true}')

    manager.extractZip = async () => writeDeployment(manager, true)
    manager.extractTarGz = manager.extractZip
    window.showInformationMessage = async (_, ...actions) => actions.includes('Download') ? 'Download' : undefined
    assert.equal(await manager.ensureBinary(), true)
    assert.equal(downloads(), 2)
    assert.equal(restarted.isBinaryInstalled(), true)
    assert.equal(fs.readFileSync(path.join(manager.binaryDir, 'resources', 'models.json'), 'utf8'), '{}')
    assert.equal(fs.existsSync(path.join(manager.binaryDir, '.install-incomplete')), false)
  })
}

test('a rejected active download releases the guard and offers a retry', async t => {
  const { manager, window, downloads } = fixture(t)
  const release = manager.getLatestRelease
  const response = deferred()
  manager.getLatestRelease = () => response.promise
  const install = manager.downloadBinary()
  const duplicate = manager.downloadBinary()
  window.showInformationMessage = async (_, ...actions) => actions.includes('Download') ? 'Download' : undefined
  const start = manager.ensureBinary()
  const results = Promise.allSettled([install, duplicate])
  manager.getLatestRelease = release
  response.reject(new Error('release lookup failed'))
  assert.equal(await start, true)
  assert.deepEqual((await results).map(result => result.status), ['rejected', 'rejected'])
  assert.equal(downloads(), 1)
  assert.equal(manager.isInstalling, false)
})

test('completed legacy layouts relocate, while executables without resources are rejected', async t => {
  const { manager } = fixture(t)
  writeDeployment(manager, true, false)
  assert.equal(manager.isBinaryInstalled(), false)
  assert.equal(await manager.ensureBinary(), false)
  writeDeployment(manager, true)
  assert.equal(await manager.ensureBinary(), true)
  assert.equal(fs.existsSync(manager.binaryPath), true)
  assert.equal(fs.existsSync(path.join(manager.binaryDir, 'resources', 'models.json')), true)
})

test('an unsuccessful download attempt cannot report a successful start', async t => {
  const { manager, window } = fixture(t)
  manager.getLatestRelease = async () => ({ tag_name: 'v1.0.0', assets: [] })
  window.showInformationMessage = async (_, ...actions) => actions.includes('Download') ? 'Download' : undefined
  assert.equal(await manager.ensureBinary(), false)
  assert.equal(manager.isInstalling, false)
})

test('an archive without resources remains incomplete and does not report success', async t => {
  const { manager, window } = fixture(t)
  manager.extractTarGz = async () => writeDeployment(manager, true, false)
  window.showInformationMessage = async (_, ...actions) => actions.includes('Download') ? 'Download' : undefined
  assert.equal(await manager.ensureBinary(), false)
  assert.equal(manager.isBinaryInstalled(), false)
  assert.equal(fs.existsSync(path.join(manager.binaryDir, '.install-incomplete')), true)
  assert.equal(fs.existsSync(path.join(manager.binaryDir, '.version')), false)
})
