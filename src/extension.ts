import { commands, ExtensionContext, TreeItem, window } from 'vscode'

import { BinaryManager } from './binaryManager'
import { ChanhLmcProvider } from './lmcProvider'
import { ChatParticipant } from './chatParticipant'
import { listenConfigsChange, ServerManager } from './serverManager'
import { draftReleaseNotes } from './releaseNotes'
import { Logger } from './logger'
import { ModelDecorationProvider } from './modelDecorations'
import { ModelManager } from './modelManager'
import { copyModelId, openLmConfigsFile, openSetting, openUrl, revealBinaryDir, walkthrough } from './utils'
import { initTokenStatsLog, showTokenUsage } from './tokenStatsLog'
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

  const d1 = rc('chanh.openWalkthrough', walkthrough)
  const d2 = rc('chanh.downloadBinary', () => binaryManager.downloadBinary())
  const d3 = rc('chanh.selectChatModel', () => modelManager.selectChatModel(chatParticipant))
  const d4 = rc('chanh.setMaxLoadedModels', () => modelManager.setMaxLoadedModels())

  const d5 = rc('chanh.openLmConfigsFile', openLmConfigsFile)
  const d6 = rc('chanh.openSettings', openSetting)
  const d7 = rc('chanh.openServerUrl', openUrl)

  const d8 = rc('chanh.editServerPort', () => serverManager.editServerPort())
  const d9 = rc('chanh.startServer', () => serverManager.start())
  const d10 = rc('chanh.stopServer', () => serverManager.stop())
  const d11 = rc('chanh.switchServer', () => serverManager.switchServer())
  const d12 = rc('chanh.refreshServer', () => refreshEvents.fire())
  const d38 = rc('chanh.showTokenUsage', () => showTokenUsage())

  // No command palette
  // Context menu
  const d13 = rc('chanh.ncp.copyModelId', (item: ModelTreeItem) => copyModelId(item))
  const d14 = rc('chanh.ncp.setModelContext', (item: ModelTreeItem) => modelManager.setModelContext(item))
  const d15 = rc('chanh.ncp.pinModel', (item: ModelTreeItem) => modelManager.pinModel(item))
  const d16 = rc('chanh.ncp.unpinModel', (item: ModelTreeItem) => modelManager.unpinModel(item))

  const d17 = rc('chanh.ncp.revealBinaryDir', () => revealBinaryDir(binaryManager.binaryDir))
  const d18 = rc('chanh.ncp.downloadModel', (item: ModelTreeItem) => modelManager.downloadModel(item))
  const d19 = rc('chanh.ncp.cancelDownload', (item: ModelTreeItem) => modelManager.cancelDownload(item.modelId))
  const d20 = rc('chanh.ncp.loadModel', (item: ModelTreeItem) => modelManager.loadModel(item.modelId))
  const d21 = rc('chanh.ncp.unloadModel', (item: ModelTreeItem) => modelManager.unloadModel(item.modelId))
  const d22 = rc('chanh.ncp.showModelInfo', (item: ModelTreeItem) => modelManager.showModelInfo(item))

  const d23 = rc('chanh.ncp.resetModelContext', (item: ModelTreeItem) => modelManager.resetModelContext(item))
  const d24 = rc('chanh.ncp.removeModel', (item: ModelTreeItem) => modelManager.deleteModel(item.modelId))

  const d25 = rc('chanh.ncp.selectBackend', (item: ModelTreeItem) => modelManager.selectBackend(item))
  const d26 = rc('chanh.ncp.uninstallBackend', (item: BackendTreeItem) => modelManager.uninstallBackend(item))

  const d27 = rc('chanh.ncp.configLmEndpoint', (item: ModelTreeItem) => modelManager.configLmEndpoint(item.modelId))
  const d28 = rc('chanh.ncp.toggleModelSectionsHide', () => svProvider.toggleModelSections())
  const d29 = rc('chanh.ncp.toggleModelSectionsShow', () => svProvider.toggleModelSections())

  const d30 = rc('chanh.ncp.toggleModelGrouping', () => svProvider.toggleModelGrouping())
  const d31 = rc('chanh.ncp.toggleDlModelGrouping', () => svProvider.toggleDlModelGrouping())
  const d32 = rc('chanh.ncp.toggleHotModels', () => svProvider.toggleHotModels())
  const d33 = rc('chanh.ncp.filterCapGroup', (item: CapGroupTreeItem) => svProvider.filterCapGroup(item))
  const d34 = rc('chanh.ncp.clearCapFilter', (item: CapGroupTreeItem) => svProvider.clearCapFilter(item))

  const d35 = listenConfigsChange(serverManager)
  const d36 = lmcProvider.register()
  const d37 = window.registerFileDecorationProvider(new ModelDecorationProvider())
  const d39 = rc('chanh.draftReleaseNotes', () => draftReleaseNotes(serverManager, chatParticipant))

  context.subscriptions.push(d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14, d15, d16, d17, d18, d19, d20,
    d21, d22, d23, d24, d25, d26, d27, d28, d29, d30, d31, d32, d33, d34, d35, d36, d37, d38, d39, serverManager,
    chatParticipant,
    lmcProvider, svProvider, Logger
  )
  binaryManager.checkForUpdates()
}

// This method is called when your extension is deactivated
export function deactivate() { }
