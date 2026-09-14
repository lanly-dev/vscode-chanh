import {
  EventEmitter,
  ExtensionContext,
  ThemeColor,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState
} from 'vscode'
const { Collapsed, Expanded, None } = TreeItemCollapsibleState

import { formatBytes, getCapIcon, getServerStatusChar } from './utils'
import { ModelDecorationProvider } from './modelDecorations'
import { ModelManager } from './modelManager'
import { refreshEvents } from './events'
import { ServerManager } from './serverManager'
import { ServerStatus } from './interfaces'

import type { DownloadProgress, LemonadeModel, ServerInstance } from './interfaces'


/** Capability grouping order and display titles for the tree view. */
const CAPABILITY_ORDER = ['llm', 'embedding', 'reranking', 'classification', 'transcription', 'tts', 'image', '3d']

const CAPABILITY_TITLES: Readonly<Record<string, string>> = {
  llm: 'LLM / Chat',
  embedding: 'Embedding',
  reranking: 'Reranking',
  classification: 'Classification',
  transcription: 'Transcription',
  tts: 'Text-to-Speech',
  image: 'Image',
  '3d': '3D',
  other: 'Other'
}

/** Storage key used to persist incomplete downloads across sessions. */
const PARTIALS_STORAGE_KEY = 'partialDownloads'

/** Storage key for the models-grouped-by-capability toggle. */
const GROUP_MODELS_KEY = 'groupModelsByCapability'

/** Storage key for the downloadable-models grouped-by-capability toggle. */
const GROUP_DOWNLOADABLE_MODELS_KEY = 'groupDownloadableModelsByCapability'

/** Storage key for the show-hot-models-only toggle (downloadable section). */
const SHOW_HOT_ONLY_KEY = 'showHotOnly'

/**
 * Tree data provider for the Servers view.
 * Shows both the standalone Lemonade app and the lemond app in a single tree.
 */
export class ServerViewProvider implements TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private _activeServer: ServerInstance | null = null

  /** In-progress model downloads, keyed by model id. */
  private _downloads = new Map<string, DownloadProgress>()
  /** Partial (incomplete) downloads, keyed by model id. */
  private _partials = new Map<string, DownloadProgress>()

  /** Whether available models are grouped by capability. */
  private _groupAvaModels = false
  /** Whether downloadable catalog models are grouped by capability. */
  private _groupDowModels = false
  /** Whether the downloadable section shows only hot models. */
  private _showHotOnly = false

  constructor(private context: ExtensionContext, private serverManager: ServerManager) {
    // Refresh whenever another part of the extension fires the shared event, or when the server status changes.
    refreshEvents.onDidRequestRefresh(() => this.refresh())
    serverManager.onStatusChange(() => this.refresh())

    // Restore any incomplete downloads saved from a previous session.
    const saved = this.context.workspaceState.get<Array<[string, number]>>(PARTIALS_STORAGE_KEY, [])
    for (const [modelId, pct] of saved) {
      const message = pct >= 0 ? `${Math.round(pct)}% downloaded` : 'download incomplete'
      this._partials.set(modelId, { modelId, pct, message })
    }

    this._groupAvaModels = this.context.workspaceState.get<boolean>(GROUP_MODELS_KEY, false)
    this._groupDowModels = this.context.workspaceState.get<boolean>(GROUP_DOWNLOADABLE_MODELS_KEY, false)
    this._showHotOnly = this.context.workspaceState.get<boolean>(SHOW_HOT_ONLY_KEY, false)
  }

  /** Flip the group-models-by-capability toggle, persist it, and refresh. */
  toggleModelGrouping(): void {
    this._groupAvaModels = !this._groupAvaModels
    void this.context.workspaceState.update(GROUP_MODELS_KEY, this._groupAvaModels)
    this.refresh()
  }

  /** Flip the group-downloadable-models-by-capability toggle, persist it, and refresh. */
  toggleDlModelGrouping(): void {
    this._groupDowModels = !this._groupDowModels
    void this.context.workspaceState.update(GROUP_DOWNLOADABLE_MODELS_KEY, this._groupDowModels)
    this.refresh()
  }

  /** Flip the show-hot-models-only toggle (downloadable section), persist it, and refresh. */
  toggleHotModels(): void {
    this._showHotOnly = !this._showHotOnly
    void this.context.workspaceState.update(SHOW_HOT_ONLY_KEY, this._showHotOnly)
    this.refresh()
  }

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  /** Record a model that just started downloading. */
  beginDownload(modelId: string): void {
    this._downloads.set(modelId, { modelId, pct: 0, message: 'Starting download...' })
    this.refresh()
  }

  /**
   * Update live download progress, refreshing the tree only when the progress
   * crosses a 2% step (so we don't re-render the whole tree on every event).
   */
  updateDownload(modelId: string, pct: number, message: string, written?: number, total?: number): void {
    const current = this._downloads.get(modelId)
    if (!current) return

    const bucket = pct >= 0 ? Math.floor(pct / 2) : -1
    const currentBucket = current.pct >= 0 ? Math.floor(current.pct / 2) : -1
    const shouldRefresh = bucket !== currentBucket && current.pct !== 0

    this._downloads.set(modelId, { modelId, pct, written, total, message })
    if (shouldRefresh) this.refresh()
  }

  /** Remove a model from the active downloads (completed or failed). */
  endDownload(modelId: string): void {
    if (this._downloads.delete(modelId)) this.refresh()
  }

  /**
   * Mark a cancelled/failed download as incomplete so it persists under
   * "Incomplete Downloads" for the user to Retry or Remove.
   */
  markPartial(modelId: string, pct: number): void {
    this._partials.set(modelId, {
      modelId,
      pct,
      message: pct >= 0 ? `${Math.round(pct)}% downloaded` : 'download incomplete'
    })
    this.persistPartials()
    this.refresh()
  }

  /** Forget an incomplete download (e.g. after a successful re-pull or remove). */
  clearPartial(modelId: string): void {
    if (!this._partials.delete(modelId)) return
    this.persistPartials()
    this.refresh()
  }

  /** Persist the current incomplete downloads so they survive a reload. */
  private async persistPartials(): Promise<void> {
    const entries: Array<[string, number]> = []
    for (const [modelId, partial] of this._partials) entries.push([modelId, partial.pct])
    await this.context.workspaceState.update(PARTIALS_STORAGE_KEY, entries)
  }

  getTreeItem(element: TreeItem): TreeItem {
    return element
  }

  /** Get children of the given element (or root if undefined). */
  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (element) return this.getChildrenForElement(element)
    // Root level - fetch fresh data
    const items: TreeItem[] = []

    await this.fetchServerData()

    // The tree shows only the currently selected target server.
    const displayServer = this._activeServer
    const displayName = displayServer?.name ?? 'No server configured'
    const displayUrl = displayServer?.url ?? ''

    // Show single active server
    const serverHeader = new TreeItem(displayName, Expanded)
    serverHeader.iconPath = new ThemeIcon('server')
    serverHeader.contextValue = 'CHANH_SERVER_HEADER'
    serverHeader.tooltip = `Active server: ${displayName}\nURL: ${displayUrl}`
    items.push(serverHeader)

    // Loaded models section
    if (this._activeServer?.status === ServerStatus.RUNNING) {
      const loadedModels = this._activeServer?.health?.all_models_loaded || []

      const loadedHeader = new TreeItem(`Loaded Models (${loadedModels.length})`, Expanded)
      let color
      if (loadedModels.length) color = new ThemeColor('charts.yellow')
      loadedHeader.iconPath = new ThemeIcon('zap', color)
      loadedHeader.contextValue = 'CHANH_LOADED_HEADER'
      items.push(loadedHeader)
    }

    // Downloading models section - only shown while a model is being pulled.
    if (this._downloads.size > 0) {
      const downloadingHeader = new TreeItem(`Downloading Models (${this._downloads.size})`, Expanded)
      downloadingHeader.iconPath = new ThemeIcon('cloud-download', new ThemeColor('charts.blue'))
      downloadingHeader.contextValue = 'CHANH_DOWNLOADING_HEADER'
      items.push(downloadingHeader)
    }

    // Incomplete downloads section - leftover partial files from cancelled/failed pulls.
    if (this._partials.size > 0) {
      const partialHeader = new TreeItem(`Incomplete Downloads (${this._partials.size})`, Expanded)
      partialHeader.iconPath = new ThemeIcon('warning', new ThemeColor('charts.yellow'))
      partialHeader.contextValue = 'CHANH_PARTIAL_HEADER'
      items.push(partialHeader)
    }


    // Available models section
    if (this._activeServer?.models) {
      const modelsHeader = new TreeItem(`Available Models (${this._activeServer.models.length})`, Expanded)
      modelsHeader.iconPath = new ThemeIcon('list-tree')
      modelsHeader.contextValue = 'CHANH_MODELS_HEADER'
      items.push(modelsHeader)
    }

    // Downloadable (not-yet-downloaded catalog) models section
    if (this._activeServer?.downloadableModels) {
      const dlModels = this._activeServer.downloadableModels
      const dlCount = this._showHotOnly
        ? dlModels.filter((m) => ModelManager.isHotModel(m)).length
        : dlModels.length
      const dlHeader = new TreeItem(`Downloadable Models (${dlCount})`, Expanded)
      dlHeader.iconPath = this._showHotOnly
        ? new ThemeIcon('flame', new ThemeColor('charts.yellow'))
        : new ThemeIcon('cloud-download')
      dlHeader.contextValue = 'CHANH_DOWNLOADABLE_HEADER'
      items.push(dlHeader)
    }
    return items
  }

  private getChildrenForElement(element: TreeItem): TreeItem[] {
    if (element.contextValue === 'CHANH_SERVER_HEADER') return this.getServerChildren(this._activeServer)
    if (element.contextValue === 'CHANH_LOADED_HEADER') return this.getLoadedModelChildren(element)
    if (element.contextValue === 'CHANH_DOWNLOADING_HEADER') return this.getDownloadingChildren()
    if (element.contextValue === 'CHANH_PARTIAL_HEADER') return this.getPartialDownloadChildren()
    if (element.contextValue === 'CHANH_PINNED_HEADER') return this.getPinnedModelChildren(element)
    if (element.contextValue === 'CHANH_MODELS_HEADER') return this.getModelChildren(element)
    if (element.contextValue === 'CHANH_DOWNLOADABLE_HEADER') return this.getDownloadableChildren()
    if (element.contextValue === 'CHANH_CAP_GROUP') return this.getCapabilityGroupChildren(element)
    return []
  }

  private getServerChildren(server: ServerInstance | null): TreeItem[] {
    if (!server) return []

    const items: TreeItem[] = []
    // Status indicator
    const { color, icon, text } = getServerStatusChar(server.status)
    const statusItem = new TreeItem(`Status: ${text}`, None)
    statusItem.iconPath = new ThemeIcon(icon, new ThemeColor(color))
    statusItem.contextValue = `CHANH_SERVER_${server.status}`
    items.push(statusItem)

    // Server URL
    const urlItem = new TreeItem(server.url, None)
    urlItem.iconPath = new ThemeIcon('link')
    urlItem.tooltip = `Server URL: ${server.url}`
    urlItem.contextValue = 'CHANH_SERVER_URL'
    items.push(urlItem)

    // Version
    if (server.version) {
      const versionItem = new TreeItem(`Version: v${server.version}`, None)
      versionItem.iconPath = new ThemeIcon('versions')
      versionItem.tooltip = 'Lemonade Server binary version'
      items.push(versionItem)
    }

    // Max loaded models
    if (server.maxLoadedModels !== undefined) {
      const maxModelsText = server.maxLoadedModels === -1 ? 'Unlimited' : String(server.maxLoadedModels)
      const maxModelsItem = new TreeItem(`Max Loaded Models: ${maxModelsText}`, None)
      maxModelsItem.iconPath = new ThemeIcon('symbol-number')
      const configLabel = server.id === 'lemond' ? ' (configured in settings)' : ''
      maxModelsItem.tooltip = `Maximum models that can be loaded simultaneously${configLabel}`
      items.push(maxModelsItem)
    }

    // Pinned models section
    if (this._activeServer?.status === ServerStatus.RUNNING) {
      const pinnedModels = this._activeServer?.health?.pinned_models
      const pinnedEntries = pinnedModels ? Object.entries(pinnedModels) : []
      const pinnedCount = pinnedEntries.reduce((sum, [, count]) => sum + (count ?? 0), 0)

      const pinnedHeader = new TreeItem(`Pinned Models (${pinnedCount})`, Collapsed)
      const pinnedColor = pinnedCount > 0 ? new ThemeColor('charts.blue') : undefined
      pinnedHeader.iconPath = new ThemeIcon('pin', pinnedColor)
      pinnedHeader.contextValue = 'CHANH_PINNED_HEADER'
      items.push(pinnedHeader)
    }

    // Error message if any
    if (server.error) {
      const errorItem = new TreeItem(`Error: ${server.error}`, None)
      errorItem.iconPath = new ThemeIcon('error', new ThemeColor('charts.red'))
      items.push(errorItem)
    }
    return items
  }

  private getLoadedModelChildren(element: TreeItem): TreeItem[] {
    const server = this._activeServer
    if (!server?.health) return []
    const loadedModels = server.health.all_models_loaded

    if (!loadedModels || loadedModels.length === 0) {
      const noModelsItem = new TreeItem('No loaded models', None)
      noModelsItem.iconPath = new ThemeIcon('circle-slash')
      return [noModelsItem]
    }

    return loadedModels.map((model) => {
      const item = new TreeItem(model.model_name, None)
      item.iconPath = new ThemeIcon('pass-filled', new ThemeColor('charts.green'))
      item.tooltip = `Model: ${model.model_name}\nBusy: ${model.is_busy}\nStreaming: ${model.is_streaming}`
      item.contextValue = 'CHANH_LOADED_MODEL'
      item.description = model.is_busy ? 'busy' : 'idle'
      return item
    })
  }

  private getDownloadingChildren(): TreeItem[] {
    const items: TreeItem[] = []
    for (const download of this._downloads.values()) {
      const item = new TreeItem(download.modelId, None)
      item.iconPath = new ThemeIcon('loading~spin', new ThemeColor('charts.blue'))
      item.contextValue = 'CHANH_DOWNLOADING_MODEL'
      item.tooltip = download.message ? `${download.modelId}\n${download.message}` : download.modelId

      const subtextParts: string[] = []
      if (download.pct >= 0) subtextParts.push(`${Math.round(download.pct)}%`)
      const sizeText = typeof download.written === 'number' && typeof download.total === 'number'
        ? `${formatBytes(download.written!)} / ${formatBytes(download.total!)}`
        : ''
      if (sizeText) subtextParts.push(sizeText)
      item.description = subtextParts.length > 0 ? subtextParts.join('  ') : download.message
      items.push(item)
    }
    return items
  }

  private getPartialDownloadChildren(): TreeItem[] {
    const items: TreeItem[] = []
    for (const partial of this._partials.values()) {
      const item = new TreeItem(partial.modelId, None) as TreeItem & { modelId: string }
      item.modelId = partial.modelId
      item.iconPath = new ThemeIcon('warning', new ThemeColor('charts.yellow'))
      item.contextValue = 'CHANH_PARTIAL_MODEL'
      item.description = partial.pct >= 0 ? `${Math.round(partial.pct)}% downloaded - incomplete` : 'incomplete'
      item.tooltip = `${partial.modelId}\nNot fully downloaded. Retry, or Remove to delete the partial file.`
      items.push(item)
    }
    return items
  }

  private getPinnedModelChildren(element: TreeItem): TreeItem[] {
    const server = this._activeServer
    const pinned = server?.health?.pinned_models
    if (!pinned) return []

    const entries = Object.entries(pinned)
    if (entries.length === 0) {
      const noItem = new TreeItem('No pinned models', None)
      noItem.iconPath = new ThemeIcon('circle-slash', new ThemeColor('charts.gray'))
      return [noItem]
    }

    return entries.map(([category, count]) => {
      const value = count ?? 0
      const item = new TreeItem(category, None)
      item.description = String(value)
      const color = value > 0 ? new ThemeColor('charts.green') : new ThemeColor('charts.gray')
      item.iconPath = new ThemeIcon('pinned', color)
      item.tooltip = `${category}: ${value} pinned`
      return item
    })
  }

  private getModelChildren(element: TreeItem): TreeItem[] {
    const server = this._activeServer
    if (!server?.models) return []

    if (server.models.length === 0) {
      const noModelsItem = new TreeItem('No models downloaded yet.', None)
      noModelsItem.iconPath = new ThemeIcon('circle-filled')
      return [noModelsItem]
    }

    if (this._groupAvaModels) return this.getCapabilityGroups(server.models)

    const loadedIds = new Set(server.health?.all_models_loaded.map((m) => m.model_name) ?? [])

    const orderedModels = this.sortModelsLoadedFirst(server.models, loadedIds)
    return orderedModels.map((model) => this.toModelItem(model, loadedIds.has(model.id)))
  }

  /** Downloadable catalog models (not yet on disk) — each pulls on click. */
  private getDownloadableChildren(): TreeItem[] {
    const models = this._activeServer?.downloadableModels ?? []
    const displayModels = this._showHotOnly ? models.filter((m) => ModelManager.isHotModel(m)) : models
    if (displayModels.length === 0) {
      const none = new TreeItem('No downloadable models available.', None)
      none.iconPath = new ThemeIcon('check')
      return [none]
    }
    if (this._groupDowModels) return this.getCapabilityGroups(displayModels, true)
    return displayModels.map((model) => this.toDownloadableItem(model))
  }

  /** Build one downloadable-model leaf row with a pull affordance. */
  private toDownloadableItem(model: LemonadeModel): TreeItem {
    const item = new TreeItem(model.id, None) as TreeItem & { modelId: string }
    item.modelId = model.id
    const sizeText = formatBytes(model.size ?? 0)
    if (sizeText) item.description = sizeText
    // Hot models get the flame icon so the user can spot them at a glance;
    // non-hot downloadable models keep the cloud-download icon.
    const isHot = ModelManager.isHotModel(model)
    item.iconPath = isHot ? getCapIcon(this.context.extensionUri, 'hot') : new ThemeIcon('circle-filled')

    let tooltip = `Downloadable model: ${model.id}${sizeText ? `\nSize: ${sizeText}` : ''}`
    if (isHot) tooltip += '\nHot model'

    item.tooltip = tooltip

    item.contextValue = 'CHANH_DOWNLOADABLE_MODEL'
    // Inline pull lives in package.json view/item/context; the row click
    // also triggers it via the viewItem's default command below.
    item.command = { command: 'chanh.downloadModel', title: 'Download Model', arguments: [item] }
    return item
  }

  /** Build one available-model leaf row (shared by flat and grouped modes). */
  private toModelItem(model: LemonadeModel, isLoaded: boolean, showHotFlame = false): TreeItem {
    const item = new TreeItem(model.id, None) as TreeItem & { modelId: string }
    item.modelId = model.id

    // Loaded models get a green label via the FileDecoration provider
    // (the tree-item API has no direct way to color label text).
    item.resourceUri = ModelDecorationProvider.uriFor(model.id, isLoaded)

    // Subtext: size only (the capability label is not listed here anymore)
    const modelLabel = ModelManager.getModelLabel(model)
    const sizeText = model.size && model.size > 0
      ? (model.size >= 1024 ? `${(model.size / 1024).toFixed(1)} TB` : `${model.size.toFixed(2)} GB`)
      : ''
    if (sizeText) item.description = sizeText

    const isHot = ModelManager.isHotModel(model)
    let tooltip = `Model: ${modelLabel ? `${model.id} (${modelLabel})` : model.id}`
    tooltip += isLoaded ? '\nLoaded' : '\nNot loaded'
    if (isHot) tooltip += '\nHot model'

    // Unloaded hot models wear the flame when grouped by capability; in the
    // flat list the flame is suppressed so no per-model marker is needed.
    if (showHotFlame && isHot && !isLoaded) item.iconPath = getCapIcon(this.context.extensionUri, 'hot')
    else if (isLoaded) item.iconPath = new ThemeIcon('pass-filled', new ThemeColor('charts.green'))
    else item.iconPath = new ThemeIcon('circle')

    item.tooltip = tooltip

    if (isLoaded) item.contextValue = 'CHANH_MODEL_LOADED'
    else item.contextValue = 'CHANH_MODEL_AVAILABLE'
    return item
  }

  /**
   * Return a copy of `models` with loaded models sorted before unloaded ones.
   * The original array is not mutated; load order among already-loaded (or
   * among not-yet-loaded) models is preserved (stable sort).
   */
  private sortModelsLoadedFirst(models: LemonadeModel[], loadedIds: Set<string>): LemonadeModel[] {
    return [...models].sort((a, b) => {
      const aLoaded = loadedIds.has(a.id) ? 0 : 1
      const bLoaded = loadedIds.has(b.id) ? 0 : 1
      return aLoaded - bLoaded
    })
  }

  /** Group available models under one collapsible header per capability. */
  private getCapabilityGroups(models: LemonadeModel[], downloadable = false): TreeItem[] {
    const grouped = new Map<string, LemonadeModel[]>()
    for (const model of models) {
      const categories = ModelManager.getCapabilityCategories(model)
      // A multi-capability model appears under every capability it has, so
      // nothing is hidden from a group it belongs to.
      if (categories.length === 0) categories.push('other')
      for (const category of categories) {
        const bucket = grouped.get(category) ?? []
        bucket.push(model)
        grouped.set(category, bucket)
      }
    }

    const order = [...CAPABILITY_ORDER, 'other']
    return order
      .filter((category) => grouped.has(category))
      .map((category) => {
        const bucket = grouped.get(category) ?? []
        const title = CAPABILITY_TITLES[category] ?? category
        const item = new TreeItem(`${title} (${bucket.length})`, Collapsed)
        item.contextValue = 'CHANH_CAP_GROUP'
        // TODO: Consider adding additional context or actions for capability groups.
        ; (item as TreeItem & { capability: string }).capability = category
        ; (item as TreeItem & { downloadable: boolean }).downloadable = downloadable
        item.tooltip = `${bucket.length} model(s) with ${title} capability`
        // Capability groups wear the matching colored SVG; "other" gets a dot.
        item.iconPath = getCapIcon(this.context.extensionUri, category)
        return item
      })
  }

  /** Models (available or downloadable) under one capability group header. */
  private getCapabilityGroupChildren(element: TreeItem): TreeItem[] {
    const capability = (element as TreeItem & { capability?: string }).capability
    const downloadable = (element as TreeItem & { downloadable?: boolean }).downloadable
    const server = this._activeServer
    if (!capability) return []

    const source = downloadable ? server?.downloadableModels : server?.models
    if (!source) return []

    // When hot-only is active, restrict downloadable models to hot ones.
    const effectiveSource = downloadable && this._showHotOnly
      ? source.filter((m) => ModelManager.isHotModel(m))
      : source

    // Multi-capability models live in every group they belong to, so the same
    // filter applies whether the source is downloaded or downloadable models.
    const filtered = effectiveSource.filter((m) => {
      const categories = ModelManager.getCapabilityCategories(m)
      if (categories.length === 0) return capability === 'other'
      return categories.includes(capability)
    })

    if (downloadable) return filtered.map((m) => this.toDownloadableItem(m))

    const loadedIds = new Set(server?.health?.all_models_loaded.map((m) => m.model_name) ?? [])
    // Within each capability group, surface loaded models first.
    const ordered = this.sortModelsLoadedFirst(filtered, loadedIds)
    return ordered.map((m) => this.toModelItem(m, loadedIds.has(m.id), true))
  }

  /** Fetch server data for all known server instances. */
  private async fetchServerData(): Promise<void> {
    this._activeServer = await this.serverManager.getActiveServer()
  }
}
