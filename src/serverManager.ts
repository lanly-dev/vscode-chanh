import { ChildProcess, exec, spawn } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(exec)

import * as fs from 'fs'
import * as path from 'path'

import { ConfigurationTarget, ExtensionContext, QuickPickItem, WorkspaceConfiguration } from 'vscode'
import { window, workspace } from 'vscode'
const { showErrorMessage, showInformationMessage, showInputBox, showQuickPick } = window

import { BinaryManager } from './binaryManager'
import { LemonadeClient } from './lemonadeClient'
import { Logger } from './logger'
import { refreshEvents } from './events'
import { ServerStatus, TargetServer, type LemonadeModel, type ServerInstance } from './interfaces'

// Manages the Lemonade Server process lifecycle.
export class ServerManager {
  private _embedPort: number = 8000
  private _standalonePort: number = 13305

  private _serverName: string = ''
  private _serverUrl: string = ''
  private _status: ServerStatus = ServerStatus.STOPPED
  private _usingExistingServer = false

  private _client: LemonadeClient
  private _fatalErrorShown = false
  private _processExited = false
  private process: ChildProcess | null = null
  private selectionChangeCallbacks: Array<() => void> = []
  private statusChangeCallbacks: Array<(status: ServerStatus) => void> = []

  constructor(private binaryManager: BinaryManager) {
    const config = workspace.getConfiguration('chanh')
    const mode = config.get<TargetServer>('targetServer', TargetServer.STANDALONE)
    this._embedPort = config.get<number>('embeddedPort', 8000)
    this._standalonePort = config.get<number>('standalonePort', 13305)
    if (mode === TargetServer.STANDALONE) this._client = new LemonadeClient(`http://localhost:${this._standalonePort}`)
    else if (mode === TargetServer.EMBEDDED) this._client = new LemonadeClient(`http://localhost:${this._embedPort}`)
    else if (mode === TargetServer.CUSTOM) {
      const customUrl = config.get<string>('customServerUrl')
      if (!customUrl) throw new Error('Custom server URL is not configured.')
      this._client = new LemonadeClient(customUrl)
    }
    else throw new Error(`Unexpected target server mode: ${mode}`) // This should never happen

    this.applyConfiguredServerMode()
  }

  /** Get the current server status. */
  get status(): ServerStatus {
    return this._status
  }

  /** Get the embedded server port. */
  get embeddedPort(): number {
    return this._embedPort
  }

  /** Get the standalone server port. */
  get standalonePort(): number {
    return this._standalonePort
  }

  /** Get the URL of the configured target server (mode-aware). */
  get url(): string {
    const config = workspace.getConfiguration('chanh')
    const mode = config.get<TargetServer>('targetServer', TargetServer.STANDALONE)
    if (mode === TargetServer.EMBEDDED) return this.embeddedUrl
    if (mode === TargetServer.CUSTOM) {
      // Custom mode without a configured URL has no valid target; fall back to
      // the standalone default rather than silently pointing at the embedded port.
      const customUrl = config.get<string>('customServerUrl', '')
      if (customUrl) return customUrl
    }
    return `http://localhost:${this._standalonePort}`
  }

  /** Get the URL of the embedded lemond server, regardless of the selected mode. */
  get embeddedUrl(): string {
    return `http://localhost:${this._embedPort}`
  }

  /** Get the currently selected server URL for chat. */
  get selectedServerUrl(): string {
    if (this._serverUrl) return this._serverUrl
    return this.url
  }

  /** Get the name of the currently selected server. */
  get selectedServerName(): string {
    if (this._serverName) return this._serverName
    return 'Missing Selected Server'
  }

  /** Get whether the embedded server is selected. */
  get isEmbeddedSelected(): boolean {
    return this.selectedServerUrl === this.embeddedUrl
  }

  /** A client bound to the currently selected server for model operations. */
  get client(): LemonadeClient {
    if (!this._client) throw new Error('Model client is not initialized.')
    this._client.setBaseUrl(this.selectedServerUrl)
    return this._client
  }

  /**
   * Fetch status for the currently selected target server and reflect it onto
   * this._status. Returns the active ServerInstance for display (or null if
   * none is configured, e.g. custom mode with no URL).
   */
  async getActiveServer(): Promise<ServerInstance | null> {
    const config = workspace.getConfiguration('chanh')
    const mode = config.get<TargetServer>('targetServer')

    let instance: ServerInstance | null
    switch (mode) {
      case TargetServer.EMBEDDED:
        instance = await this.fetchEmbeddedServer(config)
        break
      case TargetServer.CUSTOM:
        instance = await this.fetchCustomServer(config)
        break
      case TargetServer.STANDALONE:
      default:
        instance = await this.fetchStandaloneServer(config)
        break
    }

    // Reflect the active server's status onto the manager.
    if (instance) this.setStatus(instance.status)
    return instance
  }

  /** Fetch the standalone Lemonade server status. */
  private async fetchStandaloneServer(config: WorkspaceConfiguration): Promise<ServerInstance | null> {
    const standalonePort = config.get<number>('standalonePort', 13305)
    const client = new LemonadeClient(`http://localhost:${standalonePort}`)
    try {
      const health = await client.getHealth()
      const { models, downloadableModels } = await this.fetchAllCatalogModels(client)
      return {
        id: 'standalone',
        name: 'Standalone Lemonade',
        url: `http://localhost:${standalonePort}`,
        status: ServerStatus.RUNNING,
        health,
        models,
        downloadableModels,
        maxLoadedModels: health.max_loaded_models
      }
    } catch {
      return {
        id: 'standalone',
        name: 'Standalone Lemonade',
        url: `http://localhost:${standalonePort}`,
        status: ServerStatus.ERROR
      }
    }
  }

  /** Fetch the custom Lemonade server status. */
  private async fetchCustomServer(config: WorkspaceConfiguration): Promise<ServerInstance | null> {
    const customUrl = config.get<string>('customServerUrl', '')
    if (!customUrl) return null
    const client = new LemonadeClient(customUrl)
    try {
      const health = await client.getHealth()
      const { models, downloadableModels } = await this.fetchAllCatalogModels(client)
      return {
        id: 'custom',
        name: 'Custom Server',
        url: customUrl,
        status: ServerStatus.RUNNING,
        health,
        models,
        downloadableModels,
        maxLoadedModels: health.max_loaded_models
      }
    } catch {
      return null
    }
  }

  /** Split the full catalog (?show_all=true) into downloaded vs downloadable models. */
  private async fetchAllCatalogModels(client: LemonadeClient):
    Promise<{ models: LemonadeModel[], downloadableModels: LemonadeModel[] }> {
    try {
      const all = await client.listModels(true)
      return {
        models: all.filter((m) => m.downloaded !== false),
        downloadableModels: all.filter((m) => m.downloaded === false)
      }
    } catch {
      // Older servers may not support ?show_all=true — fall back to downloaded only.
      const models = await client.listModels()
      return { models, downloadableModels: [] }
    }
  }

  /** Fetch the embedded lemon server status. */
  private async fetchEmbeddedServer(config: WorkspaceConfiguration): Promise<ServerInstance | null> {
    const embeddedClient = new LemonadeClient(this.embeddedUrl)

    // First, do a non-throwing health check to determine if the server is reachable.
    // This avoids masking real errors with assumptions about why the connection failed.
    const isHealthy = await embeddedClient.checkHealth()
    if (!isHealthy) {
      // Server is not responding — return stopped status since we probed and
      // confirmed it's not reachable. This is based on the health check result,
      // not an assumption about failure mode.
      return {
        id: 'lemond',
        name: 'lemond (Embedded)',
        url: this.embeddedUrl,
        status: ServerStatus.STOPPED,
        version: this.binaryManager.getInstalledVersion() ?? undefined,
        maxLoadedModels: config.get<number>('maxLoadedModels', 1)
      }
    }

    // Server is healthy — fetch full details
    const health = await embeddedClient.getHealth()
    const { models, downloadableModels } = await this.fetchAllCatalogModels(embeddedClient)
    let maxLoadedModels = config.get<number>('maxLoadedModels', 1)

    // If the server reports its max_loaded_models, keep the extension config in sync
    if (typeof health.max_loaded_models === 'number' && Number.isInteger(health.max_loaded_models)) {
      maxLoadedModels = health.max_loaded_models
      if (config.get<number>('maxLoadedModels', 1) !== maxLoadedModels) {
        await config.update('maxLoadedModels', maxLoadedModels, ConfigurationTarget.Global)
        Logger.info(`Synced lemon.maxLoadedModels from server to ${maxLoadedModels}`)
      }
    }

    return {
      id: 'lemond',
      name: 'lemond (Embedded)',
      url: this.embeddedUrl,
      status: ServerStatus.RUNNING,
      version: this.binaryManager.getInstalledVersion() ?? undefined,
      health,
      models,
      downloadableModels,
      maxLoadedModels
    }
  }

  /** Ensure a server is running, offering to start it if needed. */
  async ensureRunning(): Promise<boolean> {
    if (this._status === ServerStatus.RUNNING) return true
    const action = await showInformationMessage(
      'Lemonade Server is not running. Start it now?',
      'Start Server',
      'Cancel'
    )
    if (action !== 'Start Server') return false
    return this.start()
  }

  /** Set the selected server for chat and notify listeners (e.g. the chat participant). */
  setSelectedServer(url: string, name: string): void {
    this._serverUrl = url
    this._serverName = name
    Logger.info(`Selected server: ${name} (${url})`)
    for (const callback of this.selectionChangeCallbacks) callback()
  }

  /** Register a callback invoked whenever the selected chat server changes. */
  onServerSelectionChange(callback: () => void): void {
    this.selectionChangeCallbacks.push(callback)
  }

  /** Apply the configured `chanh.targetServer` to the in-memory server selection. */
  async applyConfiguredServerMode(): Promise<void> {
    const config = workspace.getConfiguration('chanh')
    const mode = config.get<TargetServer>('targetServer', TargetServer.STANDALONE)
    switch (mode) {
      case TargetServer.STANDALONE: {
        const standalonePort = config.get<number>('standalonePort', 13305)
        const url = `http://localhost:${standalonePort}`
        this.setSelectedServer(url, 'Standalone Lemonade')
        // Probe the standalone server to determine actual status
        await this.refreshStatus()
        break
      }
      case TargetServer.EMBEDDED: {
        const embeddedPort = config.get<number>('embeddedPort', 8000)
        const url = `http://localhost:${embeddedPort}`
        this.setSelectedServer(url, 'lemon (Embedded)')
        // Check if an embedded server is already running at this port
        await this.refreshStatus()
        break
      }
      case TargetServer.CUSTOM: {
        const url = config.get<string>('customServerUrl', '')
        if (url) this.setSelectedServer(url, 'Custom Server')
        else {
          this.setSelectedServer('', 'Custom Server')
          this.setStatus(ServerStatus.STOPPED)
        }
        // Probe the custom server if URL is configured
        if (url) await this.refreshStatus()
        break
      }
    }
  }

  /** Probe the currently selected server and update status accordingly. */
  private async refreshStatus(): Promise<void> {
    try {
      const instance = await this.getActiveServer()
      if (instance) {
        this.setStatus(instance.status)
        Logger.info(`Server status after mode switch: ${instance.status} (${instance.name})`)
      } else {
        // getActiveServer returned null (e.g., custom server unreachable)
        this.setStatus(ServerStatus.STOPPED)
      }
    } catch (err) {
      Logger.warn(`Could not determine server status after mode switch: ${err}`)
      this.setStatus(ServerStatus.STOPPED)
    }
  }

  async selectServer(): Promise<void> {
    await this.selectServerHelper()
    refreshEvents.fire()
  }

  /** Switch the selected server */
  private async selectServerHelper(): Promise<void> {
    const config = workspace.getConfiguration('chanh')
    const standalonePort = config.get<number>('standalonePort', 13305)
    const embeddedPort = config.get<number>('embeddedPort', 8000)
    const standaloneUrl = `http://localhost:${standalonePort}`
    const embeddedUrl = `http://localhost:${embeddedPort}`
    let defaultUrl = config.get<string>('customServerUrl', '')

    const mode = config.get<TargetServer>('targetServer', TargetServer.STANDALONE)
    const items: QuickPickItem[] = []

    if (mode !== TargetServer.STANDALONE) {
      items.push({
        label: `$(server) Standalone Lemonade`,
        description: standaloneUrl,
        detail: 'The system-installed Lemonade Server'
      })
    }

    if (mode !== TargetServer.EMBEDDED) {
      items.push({
        label: `$(server-process) lemond (Embedded)`,
        description: embeddedUrl,
        detail: `The lemond binary managed by this extension`
      })
    }

    if (mode !== TargetServer.CUSTOM) {
      items.push({
        label: `$(globe) Custom Server`,
        description: defaultUrl,
        detail: 'A user-configured Lemonade Server URL'
      })
    }

    const selected = await showQuickPick(items, {
      title: 'Select Lemonade Server',
      placeHolder: 'Choose which Lemonade Server to use'
    })

    if (!selected) return

    // Select the chosen server
    if (selected.label.includes('Standalone')) {
      await config.update('targetServer', TargetServer.STANDALONE, ConfigurationTarget.Global)
      this.setSelectedServer(standaloneUrl, 'Standalone Lemonade')
    } else if (selected.label.includes('lemon')) {
      await config.update('targetServer', TargetServer.EMBEDDED, ConfigurationTarget.Global)
      this.setSelectedServer(embeddedUrl, 'lemon (Embedded)')
    } else {
      if (!defaultUrl) {
        const url = await showInputBox({
          title: 'Custom Server URL',
          prompt: 'Enter the Lemonade Server URL',
          value: defaultUrl
        })
        if (!url) return
        defaultUrl = url
      }
      if (!defaultUrl) return
      // Save to config and select
      await config.update('targetServer', TargetServer.CUSTOM, ConfigurationTarget.Global)
      await config.update('customServerUrl', defaultUrl, ConfigurationTarget.Global)
      this.setSelectedServer(defaultUrl, 'Custom Server')
    }
  }

  /**
   * Edit the active server's port (standalone/embedded) or custom URL.
   * Persists the change to config; the mode re-application and tree refresh are
   * handled by the onDidChangeConfiguration listener + a manual refresh.
   */
  async editServerPort(): Promise<void> {
    const config = workspace.getConfiguration('chanh')
    const mode = config.get<string>('targetServer', 'standalone')

    // Custom mode edits the URL; standalone/embedded edit the port.
    if (mode === 'custom') {
      const current = config.get<string>('customServerUrl', '') || 'http://localhost:13305'
      const url = await showInputBox({
        title: 'Custom Server URL',
        prompt: 'Enter the Lemonade Server URL (e.g., http://localhost:13305)',
        placeHolder: 'http://localhost:13305',
        value: current,
        validateInput: (input) => {
          const trimmed = input.trim()
          if (!trimmed) return 'Please enter a URL'
          if (!/^https?:\/\//i.test(trimmed)) return 'URL must start with http:// or https://'
          return undefined
        }
      })
      if (url === undefined || url.trim() === '') return
      await config.update('customServerUrl', url.trim(), ConfigurationTarget.Global)
      showInformationMessage(`Custom server URL updated to ${url.trim()}`)
    } else {
      const isEmbedded = mode === 'embedded'
      const key = isEmbedded ? 'embeddedPort' : 'standalonePort'
      const current = config.get<number>(key, isEmbedded ? 8000 : 13305)

      const value = await showInputBox({
        title: isEmbedded ? 'Embedded Server Port' : 'Standalone Server Port',
        prompt: `Current: ${current}. Enter the port for the ` +
          `${isEmbedded ? 'embedded' : 'standalone'} Lemonade Server.`,
        value: String(current),
        validateInput: (input) => {
          const trimmed = input.trim()
          if (!trimmed) return 'Please enter a port number'
          const n = Number(trimmed)
          if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Enter a valid port (1-65535)'
          return undefined
        }
      })
      if (value === undefined || value.trim() === '') return
      const port = Number(value.trim())
      await config.update(key, port, ConfigurationTarget.Global)
      showInformationMessage(
        `${isEmbedded ? 'Embedded' : 'Standalone'} server port updated to ${port}`
      )
    }

    // applyConfiguredServerMode + refresh are handled onDidChangeConfiguration,
    // but refresh explicitly so the new URL/port is reflected immediately.
    refreshEvents.fire()
  }

  /** Register a callback for status changes. */
  onStatusChange(callback: (status: ServerStatus) => void): void {
    this.statusChangeCallbacks.push(callback)
  }

  /** Update the status and notify callbacks (only on an actual change). */
  private setStatus(status: ServerStatus): void {
    if (this._status === status) return
    this._status = status
    for (const callback of this.statusChangeCallbacks) callback(status)
  }


  /** Start the Lemonade Server. */
  async start(): Promise<boolean> {
    const config = workspace.getConfiguration('chanh')
    const serverMode = config.get<TargetServer>('targetServer', TargetServer.STANDALONE)

    // Custom mode: connect to a user-configured URL instead of launching a process.
    if (serverMode === TargetServer.CUSTOM) {
      const customUrl = config.get<string>('customServerUrl', '')
      if (!customUrl) {
        showErrorMessage('No custom Lemonade Server URL configured. Set chanh.customServerUrl in settings first.')
        this.setStatus(ServerStatus.ERROR)
        return false
      }
      const customClient = new LemonadeClient(customUrl)

      try {
        const healthy = await customClient.checkHealth()
        if (!healthy) throw new Error('health check failed')
        this._client = customClient
        this._usingExistingServer = true
        this.setSelectedServer(customUrl, 'Custom Server')
        this.setStatus(ServerStatus.RUNNING)
        showInformationMessage(`Connected to custom Lemonade Server at ${customUrl}`)
        refreshEvents.fire()
        return true
      } catch {
        this.setStatus(ServerStatus.ERROR)
        showErrorMessage(`Failed to connect to custom Lemonade Server at ${customUrl}.`)
        return false
      }
    }

    if (this._status === ServerStatus.RUNNING || this._status === ServerStatus.STARTING) {
      Logger.warn('Server is already running or starting')
      showInformationMessage('Lemonade Server is already running')
      return true
    }

    // Read ports from config
    this._standalonePort = config.get<number>('standalonePort', 13305)
    this._embedPort = config.get<number>('embeddedPort', 8000)

    // Standalone mode: require an existing running standalone server.
    if (serverMode === TargetServer.STANDALONE) {
      Logger.info('Connecting to standalone Lemonade Server...')
      const standaloneClient = new LemonadeClient(`http://localhost:${this._standalonePort}`)
      const standaloneHealthy = await standaloneClient.checkHealth()
      if (standaloneHealthy) {
        this._usingExistingServer = true
        this._client = standaloneClient
        this.setSelectedServer(`http://localhost:${this._standalonePort}`, 'Standalone Lemonade')
        this.setStatus(ServerStatus.RUNNING)
        showInformationMessage(`Connected to Standalone Lemonade at http://localhost:${this._standalonePort}`)
        refreshEvents.fire()
        return true
      }
      this.setStatus(ServerStatus.ERROR)
      showErrorMessage(
        'Standalone Lemonade Server is not running. Start it, or set chanh.targetServer to "embedded" or "custom".'
      )
      return false
    }

    // Embedded mode: always start the embedded binary (do not auto-connect to standalone).
    if (serverMode === TargetServer.EMBEDDED) this.setSelectedServer(this.embeddedUrl, 'lemond (Embedded)')

    // No standalone server found (or embedded mode forced), start embedded lemond
    this._client = new LemonadeClient(`http://localhost:${this._embedPort}`)

    // Check if the embedded port is in use by something else
    const portInUse = await this.isPortInUse(this._embedPort)
    if (portInUse) {
      // Identify which process owns the port so we can decide how to handle it.
      const ownerPaths = await this.getListeningProcessPaths(this._embedPort)
      const ownBinary = path.resolve(this.binaryManager.binaryPath)
      const isOwnBinary = ownerPaths.some((p) => this.pathsEqual(p, ownBinary))

      if (isOwnBinary) {
        // It's the extension's own embedded binary already running on this port.
        // Reconnect to it instead of trying to start a duplicate.
        Logger.info(
          `Found the extension's own embedded server already listening on port ${this._embedPort}; connecting to it.`
        )
        this._usingExistingServer = true
        this._client = new LemonadeClient(`http://localhost:${this._embedPort}`)
        this.setSelectedServer(`http://localhost:${this._embedPort}`, 'lemond (Embedded)')
        this.setStatus(ServerStatus.RUNNING)
        showInformationMessage(
          `Connected to existing embedded Lemonade Server at http://localhost:${this._embedPort}`
        )

        refreshEvents.fire()
        return true
      }

      const owner = ownerPaths.length
        ? ownerPaths.join(', ')
        : `unknown process (PID available via netstat port ${this._embedPort})`
      showInformationMessage(
        `Port ${this._embedPort} is already in use by: ${owner}. ` +
        'If this is your own Lemonade server, connect to it via chanh.targetServer ' +
        'instead of starting a new embedded one, or change chanh.embeddedPort.'
      )
      this.setStatus(ServerStatus.ERROR)
      return false
    }

    // Ensure binary is installed
    const installed = await this.binaryManager.ensureBinary()
    if (!installed) {
      this.setStatus(ServerStatus.ERROR)
      return false
    }

    this._usingExistingServer = false
    this.setStatus(ServerStatus.STARTING)
    Logger.info(`Starting embedded Lemonade Server on port ${this._embedPort}...`)

    const binaryPath = this.binaryManager.binaryPath
    const workingDir = this.binaryManager.binaryDir

    // Write config.json with the embedded port so lemond uses it.
    // Use default cache directory to avoid Windows permission issues.
    try {
      const configPath = path.join(workingDir, 'config.json')
      const config = workspace.getConfiguration('chanh')
      const maxLoadedModels = config.get<number>('maxLoadedModels', 1)
      const configData = {
        port: this._embedPort,
        max_loaded_models: maxLoadedModels
      }
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8')
      Logger.info(`Wrote config.json with port ${this._embedPort} and max_loaded_models ${maxLoadedModels}`)
    } catch (err) {
      Logger.error('Failed to write config.json', err)
    }

    try {
      // lemond [cache_dir] [--port PORT] [--host HOST]
      this.process = spawn(binaryPath, [workingDir, '--port', String(this._embedPort)], {
        cwd: workingDir,
        env: { ...process.env },
        shell: false
      })
    } catch (err) {
      Logger.error('Failed to start server process', err)
      this.setStatus(ServerStatus.ERROR)
      showErrorMessage(`Failed to start Lemonade Server: ${err}`)
      return false
    }

    // Handle process output
    this._fatalErrorShown = false
    this._processExited = false
    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) Logger.info(`[chanh] ${text}`)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (!text) return
      Logger.warn(`[chanh] ${text}`)
      // The lemond process reports a fatal startup error (e.g. port already
      // in use) through its own logs. Surface it to the user as an error popup.
      if (!this._fatalErrorShown && /already in use|ERROR|will now exit/i.test(text)) {
        this._fatalErrorShown = true
        showErrorMessage(`Lemonade Server failed to start: ${text}`)
      }
    })

    this.process.on('error', (err) => {
      Logger.error('Server process error', err)
      this.setStatus(ServerStatus.ERROR)
      showErrorMessage(`Lemonade Server error: ${err.message}`)
    })

    this.process.on('exit', (code, signal) => {
      Logger.info(`Server process exited (code: ${code}, signal: ${signal})`)
      this.process = null
      this._processExited = true
      if (this._status !== ServerStatus.STOPPED) this.setStatus(ServerStatus.STOPPED)
    })

    // Wait for the server to be ready
    const ready = await this.waitForReady()
    if (ready) {
      this.setSelectedServer(`http://localhost:${this._embedPort}`, 'lemond (Embedded)')
      this.setStatus(ServerStatus.RUNNING)
      Logger.info('Lemonade Server is ready')
      showInformationMessage('Lemonade Server started successfully')
      refreshEvents.fire()
      return true
    }

    // The process exited before becoming ready. The real cause (e.g. port
    // already in use) was already reported, so skip the misleading timeout.
    if (this._processExited) {
      Logger.info('Server process exited before becoming ready; skipping timeout wait.')
      this.setStatus(ServerStatus.ERROR)
      return false
    }

    Logger.error('Server failed to become ready within timeout')
    this.setStatus(ServerStatus.ERROR)
    showErrorMessage('Lemonade Server failed to start within 60 seconds. Check the output for details.')
    return false
  }

  /** Check if a port is in use (by any application). */
  private async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require('net')
      const tester = net.createServer()
      tester.once('error', () => resolve(true))
      tester.once('listening', () => {
        tester.close()
        resolve(false)
      })
      tester.listen(port)
    })
  }

  /**
   * Enumerate the executable paths of processes listening on the given port.
   * Returns an empty array if the port is free or ownership cannot be resolved.
   */
  private async getListeningProcessPaths(port: number): Promise<string[]> {
    const paths: string[] = []
    try {
      if (process.platform === 'win32') {
        // Base64-encode the script to avoid PowerShell/cmd quoting pitfalls.
        const script = [
          `$pids = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue ` +
          `| Select-Object -ExpandProperty OwningProcess -Unique;`,
          `$paths = @();`,
          `foreach ($id in $pids) {`,
          `  $pr = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id) -ErrorAction SilentlyContinue;`,
          `  if ($pr -and $pr.ExecutablePath) { $paths += $pr.ExecutablePath }`,
          `};`,
          `$paths`
        ].join(' ')
        const encoded = Buffer.from(script, 'utf16le').toString('base64')
        const { stdout } = await execAsync(
          `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
          { timeout: 15000 }
        )
        paths.push(...stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
      } else {
        // Linux / macOS: find the PIDs listening on the port.
        const { stdout } = await execAsync(
          `lsof -nP -t -iTCP:${port} -sTCP:LISTEN`,
          { timeout: 15000 }
        )
        for (const rawPid of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
          const pid = parseInt(rawPid, 10)
          if (!pid) continue
          try {
            if (process.platform === 'linux') {
              // Resolve the owning executable through /proc (handles symlinks).
              paths.push(fs.realpathSync(`/proc/${pid}/exe`))
            } else {
              // macOS: lsof reports the executable file descriptor.
              const { stdout: exeOut } = await execAsync(
                `lsof -a -d txt -nP -Fn -p ${pid}`,
                { timeout: 10000 }
              )
              const match = exeOut.split(/\r?\n/).find((l) => l.startsWith('n'))
              if (match) paths.push(match.slice(1))
            }
          } catch {
            // PID disappeared or permissions denied; skip.
          }
        }
      }
    } catch {
      Logger.warn(`Could not enumerate the process owning port ${port}`)
    }
    return paths
  }

  /** Compare two executable paths, ignoring platform-specific case differences. */
  private pathsEqual(a: string, b: string): boolean {
    const na = path.resolve(a)
    const nb = path.resolve(b)
    return process.platform === 'win32'
      ? na.toLowerCase() === nb.toLowerCase()
      : na === nb
  }

  /** Wait for the server to respond to health checks. */
  private async waitForReady(timeoutMs: number = 60000): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 1000

    while (!this._processExited && Date.now() - startTime < timeoutMs) {
      try {
        const healthy = await this.client.checkHealth()
        if (healthy) return true
      } catch {
        // Server not ready yet, continue waiting
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }
    return false
  }

  /** Stop the Lemonade Server. */
  // TODO: Need to check
  async stop(): Promise<void> {
    // If using an existing server, just disconnect
    if (this._usingExistingServer) {
      Logger.info('Disconnecting from existing Lemonade Server')
      this._usingExistingServer = false
      this.setStatus(ServerStatus.STOPPED)
      showInformationMessage('Disconnected from Lemonade Server')
      refreshEvents.fire()
      return
    }

    if (!this.process) {
      Logger.info('Server is not running')
      this.setStatus(ServerStatus.STOPPED)
      refreshEvents.fire()
      return
    }

    Logger.info('Stopping Lemonade Server...')

    // Try graceful shutdown via API
    try {
      await this.client.unloadAllModels()
    } catch {
      Logger.warn('Failed to unload all models before stopping the server')
      // Ignore errors, we're shutting down anyway
    }

    // Kill the process
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM')
      // Wait a bit for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 2000))
      if (this.process && !this.process.killed) {
        Logger.warn('Server did not respond to SIGTERM, sending SIGKILL')
        this.process.kill('SIGKILL')
      }
    }

    this.process = null
    this.setStatus(ServerStatus.STOPPED)
    Logger.info('Lemonade Server stopped')
    refreshEvents.fire()
    showInformationMessage('Lemonade Server stopped')
  }


  /** Check if the server is running and healthy. */
  async isHealthy(): Promise<boolean> {
    if (this._status !== ServerStatus.RUNNING) return false
    try {
      return await this.client.checkHealth()
    } catch {
      return false
    }
  }

  /** Dispose of resources. */
  dispose(): void {
    // Only kill the process if we started it
    if (!this._usingExistingServer && this.process && !this.process.killed) this.process.kill('SIGKILL')
    this.process = null
    this._usingExistingServer = false
  }
}

/** React to configuration changes that affect which server is targeted. */
export function listenConfigsChange(serverManager: ServerManager) {
  return workspace.onDidChangeConfiguration(async (e) => {
    const settings = ['chanh.targetServer', 'chanh.customServerUrl', 'chanh.standalonePort', 'chanh.embeddedPort']

    if (settings.some((setting) => e.affectsConfiguration(setting))) {
      await serverManager.applyConfiguredServerMode()

      // When the user switches away from embedded mode, stop the local embedded process
      // it's no longer the active server.
      const config = workspace.getConfiguration('chanh')
      const newMode = config.get<string>('targetServer', 'standalone')
      // TODO: Check if stop before switching away from embedded mode
      if (newMode !== 'embedded') await serverManager.stop()

      refreshEvents.fire()
    }
  })
}
