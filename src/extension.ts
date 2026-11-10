import { commands, ExtensionContext, TreeItem, window } from 'vscode'

import { BinaryManager } from './binaryManager'
import { ChanhLmcProvider } from './lmcProvider'
import { ChatParticipant } from './chatParticipant'
import { copyModelId, openLmConfigsFile, openSetting, openUrl, revealBinaryDir, walkthrough } from './utils'
import { draftReleaseNotes } from './releaseNotes'
import { GhostTextProvider } from './completionProvider'
import { initTokenStatsLog, showTokenUsage } from './tokenStatsLog'
import { listenConfigsChange, ServerManager } from './serverManager'
import { Logger } from './logger'
import { ModelDecorationProvider } from './modelDecorations'
import { ModelManager } from './modelManager'
import { refreshEvents } from './events'
import { ServerViewProvider } from './serverTreeview'

/** Tree items carrying their Lemonade model id. */
type ModelTreeItem = TreeItem & { modelId: string }

/** Backend tree items carry their recipe and backend name. */
type BackendTreeItem = TreeItem & { recipe: string, backend: string }

/** Capability group tree items carry their capability and source section. */
type CapGroupTreeItem = TreeItem & { capability: string, downloadable?: boolean }

export async function activate(context: ExtensionContext) {
  const rc = commands.registerCommand

  // Initialize managers and the tree view
  const binaryManager = new BinaryManager(context)
  const serverManager = new ServerManager(binaryManager)
  const svProvider = await ServerViewProvider.createOrGet(context, serverManager)

  // Expose Lemonade models in the native VS Code model picker
  const lmcProvider = new ChanhLmcProvider(serverManager)

  const modelManager = new ModelManager(serverManager, svProvider, lmcProvider)
  lmcProvider.setModelManager(modelManager)
  const chatParticipant = new ChatParticipant(serverManager, modelManager, context)
  initTokenStatsLog(context)
  const ghostTextProvider = new GhostTextProvider(serverManager)
  ghostTextProvider.register()
  context.subscriptions.push(
    rc('chanh.openWalkthrough', walkthrough),
    rc('chanh.downloadBinary', () => binaryManager.downloadBinary()),
    rc('chanh.selectChatModel', () => modelManager.selectChatModel(chatParticipant)),
    rc('chanh.setMaxLoadedModels', () => modelManager.setMaxLoadedModels()),

    rc('chanh.openLmConfigsFile', openLmConfigsFile),
    rc('chanh.openSettings', openSetting),
    rc('chanh.openServerUrl', openUrl),

    rc('chanh.editServerPort', () => serverManager.editServerPort()),
    rc('chanh.startServer', () => serverManager.start()),
    rc('chanh.stopServer', () => serverManager.stop()),
    rc('chanh.switchServer', () => serverManager.switchServer()),
    rc('chanh.refreshServer', () => refreshEvents.fire()),
    rc('chanh.showTokenUsage', () => showTokenUsage()),
    // No command palette
    // Context menu
    rc('chanh.ncp.copyModelId', (item: ModelTreeItem) => copyModelId(item)),
    rc('chanh.ncp.setModelContext', (item: ModelTreeItem) => modelManager.setModelContext(item)),
    rc('chanh.ncp.pinModel', (item: ModelTreeItem) => modelManager.pinModel(item)),
    rc('chanh.ncp.unpinModel', (item: ModelTreeItem) => modelManager.unpinModel(item)),

    rc('chanh.ncp.revealBinaryDir', () => revealBinaryDir(binaryManager.binaryDir)),
    rc('chanh.ncp.downloadModel', (item: ModelTreeItem) => modelManager.downloadModel(item)),
    rc('chanh.ncp.cancelDownload', (item: ModelTreeItem) => modelManager.cancelDownload(item.modelId)),
    rc('chanh.ncp.loadModel', (item: ModelTreeItem) => modelManager.loadModel(item.modelId)),
    rc('chanh.ncp.unloadModel', (item: ModelTreeItem) => modelManager.unloadModel(item.modelId)),
    rc('chanh.ncp.showModelInfo', (item: ModelTreeItem) => modelManager.showModelInfo(item)),

    rc('chanh.ncp.resetModelContext', (item: ModelTreeItem) => modelManager.resetModelContext(item)),
    rc('chanh.ncp.removeModel', (item: ModelTreeItem) => modelManager.deleteModel(item.modelId)),

    rc('chanh.ncp.selectBackend', (item: ModelTreeItem) => modelManager.selectBackend(item)),
    rc('chanh.ncp.uninstallBackend', (item: BackendTreeItem) => modelManager.uninstallBackend(item)),

    rc('chanh.ncp.configLmEndpoint', (item: ModelTreeItem) => modelManager.configLmEndpoint(item.modelId)),
    rc('chanh.ncp.toggleModelSectionsHide', () => svProvider.toggleModelSections()),
    rc('chanh.ncp.toggleModelSectionsShow', () => svProvider.toggleModelSections()),

    rc('chanh.ncp.toggleModelGrouping', () => svProvider.toggleModelGrouping()),
    rc('chanh.ncp.toggleDlModelGrouping', () => svProvider.toggleDlModelGrouping()),
    rc('chanh.ncp.toggleHotModels', () => svProvider.toggleHotModels()),
    rc('chanh.ncp.filterCapGroup', (item: CapGroupTreeItem) => svProvider.filterCapGroup(item)),
    rc('chanh.ncp.clearCapFilter', (item: CapGroupTreeItem) => svProvider.clearCapFilter(item)),

    listenConfigsChange(serverManager),
    lmcProvider.register(),
    window.registerFileDecorationProvider(new ModelDecorationProvider()),
    rc('chanh.draftReleaseNotes', () => draftReleaseNotes(serverManager, chatParticipant)),

    // Ghost-text (inline) completions; inert unless chanh.completions.enabled
    rc('chanh.test.ghostText', () => ghostTextProvider.testGhostText()),
    serverManager, chatParticipant, ghostTextProvider, lmcProvider, svProvider, Logger
  )
  binaryManager.checkForUpdates()
}

// This method is called when your extension is deactivated
export function deactivate() { }
