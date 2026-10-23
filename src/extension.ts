import { commands, ExtensionContext, TreeItem, window } from 'vscode'

import { BinaryManager } from './binaryManager'
import { ChanhLmcProvider } from './lmcProvider'
import { ChatParticipant } from './chatParticipant'
import { listenConfigsChange, ServerManager } from './serverManager'
import { Logger } from './logger'
import { ModelDecorationProvider } from './modelDecorations'
import { ModelManager } from './modelManager'
import { copyModelId, openLmConfigsFile, openSetting, openUrl, revealBinaryDir } from './utils'
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

  const d1 = rc('chanh.downloadBinary', () => binaryManager.downloadBinary())
  const d2 = rc('chanh.selectChatModel', () => modelManager.selectChatModel(chatParticipant))
  const d3 = rc('chanh.setMaxLoadedModels', () => modelManager.setMaxLoadedModels())

  const d4 = rc('chanh.openLmConfigsFile', openLmConfigsFile)
  const d5 = rc('chanh.openSettings', openSetting)
  const d6 = rc('chanh.openServerUrl', openUrl)

  const d7 = rc('chanh.editServerPort', () => serverManager.editServerPort())
  const d8 = rc('chanh.startServer', () => serverManager.start())
  const d9 = rc('chanh.stopServer', () => serverManager.stop())
  const d10 = rc('chanh.switchServer', () => serverManager.switchServer())
  const d11 = rc('chanh.refreshServer', () => refreshEvents.fire())

  // No command palette
  const d12 = rc('chanh.ncp.revealBinaryDir', () => revealBinaryDir(binaryManager.binaryDir))
  const d13 = rc('chanh.ncp.downloadModel', (item: ModelTreeItem) => modelManager.downloadModel(item))
  const d14 = rc('chanh.ncp.cancelDownload', (item: ModelTreeItem) => modelManager.cancelDownload(item.modelId))
  const d15 = rc('chanh.ncp.loadModel', (item: ModelTreeItem) => modelManager.loadModel(item.modelId))
  const d16 = rc('chanh.ncp.unloadModel', (item: ModelTreeItem) => modelManager.unloadModel(item.modelId))
  const d17 = rc('chanh.ncp.showModelInfo', (item: ModelTreeItem) => modelManager.showModelInfo(item))
  const d35 = rc('chanh.ncp.pinModel', (item: ModelTreeItem) => modelManager.pinModel(item))
  const d36 = rc('chanh.ncp.unpinModel', (item: ModelTreeItem) => modelManager.unpinModel(item))

  const d18 = rc('chanh.ncp.copyModelId', (item: ModelTreeItem) => copyModelId(item))
  const d19 = rc('chanh.ncp.setModelContext', (item: ModelTreeItem) => modelManager.setModelContext(item))
  const d20 = rc('chanh.ncp.resetModelContext', (item: ModelTreeItem) => modelManager.resetModelContext(item))
  const d21 = rc('chanh.ncp.removeModel', (item: ModelTreeItem) => modelManager.deleteModel(item.modelId))

  const d22 = rc('chanh.ncp.selectBackend', (item: ModelTreeItem) => modelManager.selectBackend(item))
  const d23 = rc('chanh.ncp.uninstallBackend', (item: BackendTreeItem) => modelManager.uninstallBackend(item))

  const d24 = rc('chanh.ncp.configLmEndpoint', (item: ModelTreeItem) => modelManager.configLmEndpoint(item.modelId))
  const d25 = rc('chanh.ncp.toggleModelSectionsHide', () => svProvider.toggleModelSections())
  const d26 = rc('chanh.ncp.toggleModelSectionsShow', () => svProvider.toggleModelSections())

  const d27 = rc('chanh.ncp.toggleModelGrouping', () => svProvider.toggleModelGrouping())
  const d28 = rc('chanh.ncp.toggleDlModelGrouping', () => svProvider.toggleDlModelGrouping())
  const d29 = rc('chanh.ncp.toggleHotModels', () => svProvider.toggleHotModels())
  const d30 = rc('chanh.ncp.filterCapGroup', (item: CapGroupTreeItem) => svProvider.filterCapGroup(item))
  const d31 = rc('chanh.ncp.clearCapFilter', (item: CapGroupTreeItem) => svProvider.clearCapFilter(item))

  const d32 = listenConfigsChange(serverManager)
  const d33 = lmcProvider.register()
  const d34 = window.registerFileDecorationProvider(new ModelDecorationProvider())

  context.subscriptions.push(d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14, d15, d16, d17, d18, d19, d20,
    d21, d22, d23, d24, d25, d26, d27, d28, d29, d30, d31, d32, d33, d34, d35, d36, serverManager, chatParticipant,
    lmcProvider, svProvider, Logger
  )
  binaryManager.checkForUpdates()
}

// This method is called when your extension is deactivated
export function deactivate() { }
