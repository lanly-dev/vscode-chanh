import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as https from 'https'
import * as path from 'path'
import * as vscode from 'vscode'

import { Logger } from './logger'
import { ServerMode, type GitHubRelease } from './interfaces'

const execAsync = promisify(exec)
const GITHUB_API = 'https://api.github.com/repos/lemonade-sdk/lemonade/releases/latest'

export class BinaryManager {
  constructor(private context: vscode.ExtensionContext) { }

  /** Shared completion of the active binary download/extract/merge. */
  private installPromise: Promise<void> | undefined

  /** Whether a binary install is currently in progress. */
  get isInstalling(): boolean {
    return this.installPromise !== undefined
  }

  /**
   * Directory where the binary is stored (user storage — survives extension updates).
   * Uses the non-deprecated {@link vscode.ExtensionContext.globalStorageUri} + `fsPath`.
   */
  get binaryDir(): string {
    // globalStorageUri is a vscode.Uri; .fsPath gives the absolute OS path.
    return path.join(this.context.globalStorageUri.fsPath, 'bin', 'lemonade-server')
  }

  /** Path to the lemond executable. */
  get binaryPath(): string {
    const isWindows = process.platform === 'win32'
    return path.join(this.binaryDir, isWindows ? 'lemond.exe' : 'lemond')
  }

  /** Path to the lemonade CLI executable. */
  get cliPath(): string {
    const isWindows = process.platform === 'win32'
    return path.join(this.binaryDir, isWindows ? 'lemonade.exe' : 'lemonade')
  }

  /** Check if the binary is installed. */
  isBinaryInstalled(): boolean {
    // A failed or interrupted extraction can leave an executable and only
    // some resources behind. Only a completed install clears this marker.
    if (fs.existsSync(path.join(this.binaryDir, '.install-incomplete'))) return false
    // Check if the binary exists in a subdirectory (from a previous extraction)
    const isWindows = process.platform === 'win32'
    const lemondName = isWindows ? 'lemond.exe' : 'lemond'
    const binary = fs.existsSync(this.binaryPath) ? this.binaryPath : this.findFile(this.binaryDir, lemondName)
    return binary !== null && fs.existsSync(path.join(path.dirname(binary), 'resources'))
  }

  /** Get the installed version, or null if not installed. */
  getInstalledVersion(): string | null {
    const versionFile = path.join(this.binaryDir, '.version')
    if (fs.existsSync(versionFile)) return fs.readFileSync(versionFile, 'utf8').trim()
    return null
  }

  /** Detect the platform-specific asset name. Returns undefined when this
   *  platform has no published release asset (e.g. Intel Macs). */
  private getAssetName(version: string): string | undefined {
    const platform = process.platform
    const arch = process.arch

    const prefix = `lemonade-embeddable-${version}`
    if (platform === 'win32' && arch === 'x64') return `${prefix}-windows-x64.zip`

    if (platform === 'linux') {
      if (arch === 'x64') return `${prefix}-ubuntu-x64.tar.gz`
      else return `${prefix}-ubuntu-arm64.tar.gz`
    }

    if (platform === 'darwin' && arch === 'arm64') return `${prefix}-macos-arm64.tar.gz`

    return undefined
  }

  /** Fetch the latest release info from GitHub. */
  async getLatestRelease(): Promise<GitHubRelease> {
    return this.fetchJson(GITHUB_API)
  }

  /** Fetch JSON from a URL with proper headers. */
  private fetchJson(url: string): Promise<GitHubRelease> {
    return new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'vscode-chanh-extension',
          Accept: 'application/vnd.github+json'
        }
      }
      const req = https.get(url, options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location
          if (location) return this.fetchJson(location).then(resolve).catch(reject)
          return reject(new Error('Redirect without location header'))
        }
        if (res.statusCode !== 200) {
          let body = ''
          res.on('data', (chunk) => body += chunk)
          res.on('end', () => reject(new Error(`GitHub API returned ${res.statusCode}: ${body}`)))
          return
        }
        let data = ''
        res.on('data', (chunk) => data += chunk)
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as GitHubRelease)
          } catch (err) {
            reject(new Error(`Failed to parse GitHub API response: ${err}`))
          }
        })
      })
      // Inactivity guard: a hung api.github.com must not leave the
      // fire-and-forget checkForUpdates() promise dangling at startup.
      req.setTimeout(15000, () => req.destroy(new Error('GitHub API request timed out after 15s')))
      req.on('error', reject)
    })
  }

  /** Download a file with progress reporting. An inactivity watchdog (10s)
   *  rejects if no data arrives, and an optional token cancels the request. */
  private downloadFile(
    url: string,
    dest: string,
    progress?: (percent: number) => void,
    token?: vscode.CancellationToken
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest)
      let stallTimer: NodeJS.Timeout | undefined
      const resetStallTimer = () => {
        if (stallTimer !== undefined) clearTimeout(stallTimer)
        stallTimer = undefined
      }
      const urlRequest = https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location
          if (location) {
            file.close()
            fs.unlinkSync(dest)
            resetStallTimer()
            return this.downloadFile(location, dest, progress, token).then(resolve).catch(reject)
          }
          return reject(new Error('Redirect without location header'))
        }
        if (res.statusCode !== 200) {
          file.close()
          fs.unlinkSync(dest)
          resetStallTimer()
          return reject(new Error(`Download failed with status ${res.statusCode}`))
        }

        // No fallbacks: rely on the Content-Length header only. When the
        // server doesn't send it, no progress percentage can be computed and
        // the download simply proceeds without one.
        const contentLength = res.headers['content-length']
        const totalBytes = contentLength ? parseInt(contentLength, 10) : NaN
        let receivedBytes = 0

        res.on('data', (chunk) => {
          receivedBytes += chunk.length
          if (Number.isFinite(totalBytes) && totalBytes > 0 && progress) {
            const percent = Math.round((receivedBytes / totalBytes) * 100)
            progress(percent)
          }
        })

        res.pipe(file)
        // Inactivity watchdog: a hung server must not block the download
        // forever. Model pulls already enforce this with their 10s stall
        // timer; the initial binary download gets the same treatment.
        if (token?.isCancellationRequested) {
          file.close()
          fs.unlinkSync(dest)
          resetStallTimer()
          reject(new Error('Download cancelled'))
          return
        }
        stallTimer = setTimeout(() => {
          file.close()
          fs.unlinkSync(dest)
          resetStallTimer()
          reject(new Error('Download stalled: no data received for 10s'))
        }, 10000)

        file.on('finish', () => {
          resetStallTimer()
          file.close()
          resolve()
        })
        file.on('error', (err) => {
          resetStallTimer()
          fs.unlinkSync(dest)
          reject(err)
        })
      })

      urlRequest.on('error', (err) => {
        resetStallTimer()
        file.close()
        // Remove the partially downloaded file if it exists
        if (fs.existsSync(dest)) fs.unlinkSync(dest)
        reject(err)
      })

      // Abort the request if the caller dismisses the progress popup.
      if (token) {
        token.onCancellationRequested(() => {
          urlRequest.destroy(new Error('Download cancelled by user'))
        })
      }
    })
  }

  /** Extract a zip file (Windows). */
  private async extractZip(zipPath: string, destDir: string): Promise<void> {
    const isWindows = process.platform === 'win32'
    if (isWindows) {
      // Use PowerShell's Expand-Archive on Windows
      await execAsync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`)
    } else {
      // Use unzip on Unix
      await execAsync(`unzip -o '${zipPath}' -d '${destDir}'`)
    }
  }

  /** Extract a tar.gz file (Linux/macOS). */
  private async extractTarGz(tarPath: string, destDir: string): Promise<void> {
    await execAsync(`tar -xzf '${tarPath}' -C '${destDir}'`)
  }

  /**
   * Download and install the Lemonade Server binary.
   * A call while an install is already running awaits that install — see
   * {@link ensureBinary} for why concurrent installs/starts are unsafe.
   */
  async downloadBinary(): Promise<void> {
    if (this.installPromise) {
      Logger.info('Binary install already in progress; waiting for the active request')
      return this.installPromise
    }
    this.installPromise = this.doDownloadBinary()
    try {
      await this.installPromise
    } finally {
      this.installPromise = undefined
    }
  }

  /** The install itself; only ever run under the {@link downloadBinary} guard. */
  private async doDownloadBinary(): Promise<void> {
    Logger.info('Fetching latest release...')

    const release = await this.getLatestRelease()
    const version = release.tag_name.replace(/^v/, '')
    Logger.info(`Latest release: ${release.tag_name}`)

    const assetName = this.getAssetName(version)
    if (assetName === undefined) {
      const msg = 'This platform is not supported. Lemonade Server cannot be installed.'
      Logger.info(msg)
      vscode.window.showErrorMessage(msg)
      return
    }
    const asset = release.assets.find((a) => a.name === assetName)

    if (!asset) {
      const msg = `Could not find asset '${assetName}' in release ${release.tag_name}`
      Logger.error(msg)
      vscode.window.showErrorMessage(msg)
      return
    }

    // Ensure the binary directory exists
    fs.mkdirSync(this.binaryDir, { recursive: true })

    // Download the archive
    const archivePath = path.join(this.binaryDir, assetName)
    Logger.info(`Downloading ${assetName} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`)

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading Lemonade Server v${version}`,
        cancellable: true
      },
      async (progress, token) => {
        let lastReported = 0
        await this.downloadFile(asset.browser_download_url, archivePath, (percent) => {
          const increment = percent - lastReported
          if (increment > 0) {
            progress.report({ increment, message: `${percent}% downloaded` })
            lastReported = percent
          }
        }, token)
      }
    )

    Logger.info('Download complete. Extracting...')

    const incompleteMarker = path.join(this.binaryDir, '.install-incomplete')
    try {
      const retryingIncompleteInstall = fs.existsSync(incompleteMarker)
      // Keep partial installs unusable across failures and extension restarts.
      fs.writeFileSync(incompleteMarker, '')
      if (retryingIncompleteInstall) {
        // A previous merge may have copied the executable and partial resources.
        // Rebuild these so relocation cannot skip them on retry.
        fs.rmSync(this.binaryPath, { force: true })
        fs.rmSync(path.join(this.binaryDir, 'resources'), { recursive: true, force: true })
      }

      // Extract the archive
      if (assetName.endsWith('.zip')) await this.extractZip(archivePath, this.binaryDir)
      else await this.extractTarGz(archivePath, this.binaryDir)

      // Clean up the archive now that extraction has succeeded
      fs.unlinkSync(archivePath)

      // The archive may extract into a subdirectory. Find the binary.
      this.locateBinaryFiles()
      if (!fs.existsSync(this.binaryPath) || !fs.existsSync(path.join(this.binaryDir, 'resources'))) {
        throw new Error('Extracted installation is missing the executable or resources')
      }

      // Make the binary executable on Unix
      if (process.platform !== 'win32') {
        fs.chmodSync(this.binaryPath, 0o755)
        if (fs.existsSync(this.cliPath)) fs.chmodSync(this.cliPath, 0o755)
      }

      // Save the version
      const versionFile = path.join(this.binaryDir, '.version')
      fs.writeFileSync(versionFile, version, 'utf8')
      fs.unlinkSync(incompleteMarker)

      Logger.info(`Lemonade Server v${version} installed successfully`)
      vscode.window.showInformationMessage('Lemonade Server binary downloaded successfully')
    } catch (err: unknown) {
      Logger.error('Failed to install Lemonade Server', err)
      // Leave the incomplete marker in place so a partial tree is never
      // accepted, while preserving existing configuration and cached models.
      if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath)
      vscode.window.showErrorMessage('Failed to install Lemonade Server after download.')
    }
  }

  /**
   * Find the lemond/lemonade executables after extraction.
   * The archive may extract into a subdirectory whose contents we need to
   * merge into the binary directory root (resources/, config.json, etc. must
   * sit next to the lemond executable for it to start correctly).
   */
  private locateBinaryFiles(): void {
    const isWindows = process.platform === 'win32'
    const lemondName = isWindows ? 'lemond.exe' : 'lemond'
    const lemonadeName = isWindows ? 'lemonade.exe' : 'lemonade'

    // If the binary is already in the right place, nothing to do
    if (fs.existsSync(this.binaryPath)) return

    // Find a subdirectory that contains the lemond executable
    const found = this.findFile(this.binaryDir, lemondName)
    if (!found) {
      Logger.error(`Could not locate ${lemondName} after extraction`)
      return
    }

    // The executable's parent directory contains the full deployment layout
    const sourceDir = path.dirname(found)
    if (sourceDir !== this.binaryDir) {
      Logger.info(`Merging extracted contents from ${sourceDir} into ${this.binaryDir}`)
      this.mergeDirectory(sourceDir, this.binaryDir)
    }

    const foundCli = this.findFile(this.binaryDir, lemonadeName)
    if (foundCli) Logger.info(`Found lemonade CLI at ${foundCli}`)
  }

  /** Recursively merge sourceDir into targetDir. */
  private mergeDirectory(sourceDir: string, targetDir: string): void {
    fs.mkdirSync(targetDir, { recursive: true })
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(sourceDir, entry.name)
      const dstPath = path.join(targetDir, entry.name)
      if (entry.isDirectory()) this.mergeDirectory(srcPath, dstPath)
      else {
        // Do not overwrite an existing file unless it's the binary
        if (fs.existsSync(dstPath) && entry.name !== 'lemond.exe' && entry.name !== 'lemond') continue
        fs.mkdirSync(path.dirname(dstPath), { recursive: true })
        fs.copyFileSync(srcPath, dstPath)
      }
    }
  }

  /** Recursively search for a file by name. */
  private findFile(dir: string, fileName: string): string | null {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isFile() && entry.name === fileName) return fullPath
        if (entry.isDirectory()) {
          const found = this.findFile(fullPath, fileName)
          if (found) return found
        }
      }
    } catch (error) {
      // Ignore errors reading directories
      Logger.error(`Error reading directory: ${dir}`, error)
    }
    return null
  }

  /** Ensure the binary is installed, downloading if necessary. */
  async ensureBinary(): Promise<boolean> {
    // An install is already running (e.g. the user clicked Download on
    // the missing-binary prompt, then asked to start the server): wait
    // for it instead of judging the half-written tree on disk. The
    // executable appears in a subdirectory BEFORE resources/ is merged
    // next to it, and starting from that partial layout launches a
    // broken server. Once the install settles, fall through — the
    // binary is either installed (return true below) or it is not, in
    // which case the prompt path runs and a failed/cancelled install
    // is simply offered again.
    if (this.installPromise) {
      Logger.info('Binary install in progress; waiting for it to finish before continuing')
      vscode.window.showInformationMessage(
        'Lemonade Server is still installing — the start will continue when it finishes.'
      )
      try {
        await this.installPromise
      } catch (err) {
        Logger.error('Active binary install failed', err)
      }
    }

    // If the binary exists in a subdirectory, move it to the right place
    if (this.isBinaryInstalled() && !fs.existsSync(this.binaryPath)) {
      Logger.info('Binary found in subdirectory, relocating...')
      this.locateBinaryFiles()
    }

    if (this.isBinaryInstalled()) {
      Logger.info('Lemonade Server binary already installed')
      return true
    }

    const action = await vscode.window.showInformationMessage(
      'Lemonade Server binary is not installed. Would you like to download it now?',
      'Download',
      'Cancel'
    )

    if (action === 'Download') {
      try {
        await this.downloadBinary()
        return this.isBinaryInstalled()
      } catch (err) {
        Logger.error('Failed to download binary', err)
        vscode.window.showErrorMessage(`Failed to download Lemonade Server: ${err}`)
        return false
      }
    }
    return false
  }

  /** Check for updates and optionally install them. */
  async checkForUpdates(): Promise<void> {
    const mode = vscode.workspace.getConfiguration('chanh').get<ServerMode>('serverMode')
    if (mode !== ServerMode.LEMOND) return
    if (!this.isBinaryInstalled()) {
      Logger.info('Binary not installed, skipping update check')
      return
    }

    // Only hit api.github.com once per day via globalState.
    // Use wall-clock time (Date.now) so the throttle survives VS Code restarts.
    const throttleKey = 'chanh.lastUpdateCheck'
    const DAY_MS = 24 * 60 * 60 * 1000
    const lastCheck = this.context.globalState.get<number>(throttleKey, 0)
    const now = Date.now()
    if (lastCheck > 0 && now - lastCheck < DAY_MS) {
      Logger.info('Update check skipped (throttled, last check < 24h ago)')
      return
    }
    try {
      const release = await this.getLatestRelease()
      // Throttle only after a successful fetch: a network failure must not
      // consume the day's check, otherwise the user waits 24h for a retry.
      await this.context.globalState.update(throttleKey, now)
      const latestVersion = release.tag_name.replace(/^v/, '')
      const installedVersion = this.getInstalledVersion()

      if (installedVersion !== latestVersion) {
        Logger.info(`Update available: ${installedVersion} -> ${latestVersion}`)
        const action = await vscode.window.showInformationMessage(
          `Lemonade Server update available: v${latestVersion} (installed: v${installedVersion}). Update now?`,
          'Update',
          'Later'
        )
        if (action === 'Update') await this.downloadBinary()
      } else Logger.info(`Lemonade Server is up to date (v${installedVersion})`)
    } catch (err) {
      Logger.error('Failed to check for updates', err)
    }
  }
}
