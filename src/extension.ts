import { commands, ConfigurationTarget, ExtensionContext, TreeItem, window, workspace } from 'vscode'

import { BinaryManager } from './binaryManager'
import { ChanhLmcProvider } from './lmcProvider'
import { ChatParticipant } from './chatParticipant'
import { listenConfigsChange, ServerManager } from './serverManager'
import { Logger } from './logger'
import { ModelDecorationProvider } from './modelDecorations'
import { ModelManager } from './modelManager'
import { openSetting, openUrl, revealBinaryDir } from './utils'
import { refreshEvents } from './events'
import { ServerViewProvider } from './serverTreeview'

/** Tree items carrying their Lemonade model id. */
type ModelTreeItem = TreeItem & { modelId: string }

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
  const chatParticipant = new ChatParticipant(serverManager, modelManager)

  // No command palette (tree-item actions)
  const d1 = rc('chanh.ncp.downloadModel', (item: ModelTreeItem) => modelManager.downloadModel(item))
  const d2 = rc('chanh.ncp.cancelDownload', (item: ModelTreeItem) => modelManager.cancelDownload(item.modelId))
  const d3 = rc('chanh.ncp.loadModel', (item: ModelTreeItem) => modelManager.loadModel(item.modelId))
  const d4 = rc('chanh.ncp.unloadModel', (item: ModelTreeItem) => modelManager.unloadModel(item.modelId))
  const d5 = rc('chanh.ncp.removeModel', (item: ModelTreeItem) => modelManager.deleteModel(item.modelId))
  const d6 = rc('chanh.ncp.setModelContext', (item: ModelTreeItem) => modelManager.setModelContext(item))
  const d7 = rc('chanh.ncp.resetModelContext', (item: ModelTreeItem) => modelManager.resetModelContext(item))
  const d8 = rc('chanh.ncp.showModelInfo', (item: ModelTreeItem) => modelManager.showModelInfo(item))
  const d26 = rc('chanh.ncp.selectBackend', (item: ModelTreeItem) => modelManager.selectBackend(item))

  const d9 = rc('chanh.startServer', () => serverManager.start())
  const d10 = rc('chanh.stopServer', () => serverManager.stop())
  const d11 = rc('chanh.downloadBinary', () => binaryManager.downloadBinary())
  const d12 = rc('chanh.ncp.revealBinaryDir', () => revealBinaryDir(binaryManager.binaryDir))
  const d13 = rc('chanh.openSettings', openSetting)
  const d14 = rc('chanh.openServerUrl', openUrl)
  const d15 = rc('chanh.selectChatModel', () => modelManager.selectChatModel(chatParticipant))
  const d16 = rc('chanh.switchServer', () => serverManager.switchServer())
  const d17 = rc('chanh.refreshServer', () => refreshEvents.fire())
  const d18 = rc('chanh.setMaxLoadedModels', () => modelManager.setMaxLoadedModels())
  const d19 = rc('chanh.editServerPort', () => serverManager.editServerPort())

  const d20 = rc('chanh.toggleModelGrouping', () => svProvider.toggleModelGrouping())
  const d21 = rc('chanh.toggleDlModelGrouping', () => svProvider.toggleDlModelGrouping())
  const d22 = rc('chanh.toggleHotModels', () => svProvider.toggleHotModels())

  const d23 = listenConfigsChange(serverManager)
  const d24 = lmcProvider.register()
  const d25 = window.registerFileDecorationProvider(new ModelDecorationProvider())

  context.subscriptions.push(d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14, d15, d16,
    d17, d18, d19, d20, d21, d22, d23, d24, d25, d26, serverManager, chatParticipant, lmcProvider, svProvider,
    Logger.toDisposable())
  binaryManager.checkForUpdates()
}

// This method is called when your extension is deactivated
export function deactivate() { }
