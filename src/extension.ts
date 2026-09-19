import { commands, ExtensionContext, TreeItem, window } from 'vscode'

import { BinaryManager } from './binaryManager'
import { ChatParticipant } from './chatParticipant'
import { ChanhLmcProvider } from './lmcProvider'
import { Logger } from './logger'
import { ModelDecorationProvider } from './modelDecorations'
import { ModelManager } from './modelManager'
import { listenConfigsChange, ServerManager } from './serverManager'
import { ServerViewProvider } from './serverTreeview'

import { openSetting, openUrl } from './utils'
import { refreshEvents } from './events'

/** Tree items carrying their Lemonade model id. */
type ModelTreeItem = TreeItem & { modelId: string }

export async function activate(context: ExtensionContext) {
  const rc = commands.registerCommand

  // Initialize managers and the tree view (mirrors the audio-lab style:
  // a singleton-ish provider obtained via `createOrGet`).
  const binaryManager = new BinaryManager(context)
  const serverManager = new ServerManager(binaryManager)
  const p = await ServerViewProvider.createOrGet(context, serverManager)

  // Expose Lemonade models in the native VS Code model picker (like Ollama).
  const lmcProvider = new ChanhLmcProvider(serverManager)

  const modelManager = new ModelManager(serverManager, p, lmcProvider)
  lmcProvider.setModelManager(modelManager)
  const chatParticipant = new ChatParticipant(serverManager, modelManager)

  // No command palette (tree-item actions)
  const d1 = rc('chanh.ncp.downloadModel', (item: ModelTreeItem) => modelManager.downloadModel(item))
  const d2 = rc('chanh.ncp.cancelDownload', (item: ModelTreeItem) => modelManager.cancelDownload(item.modelId))
  const d3 = rc('chanh.ncp.loadModel', (item: ModelTreeItem) => modelManager.loadModel(item.modelId))
  const d4 = rc('chanh.ncp.unloadModel', (item: ModelTreeItem) => modelManager.unloadModel(item.modelId))
  const d5 = rc('chanh.ncp.removeModel', async (item: ModelTreeItem) => modelManager.deleteModel(item.modelId))
  const d6 = rc('chanh.ncp.setModelContext', (item: ModelTreeItem) => modelManager.setModelContext(item))
  const d7 = rc('chanh.ncp.resetModelContext', (item: ModelTreeItem) => modelManager.resetModelContext(item))
  const d8 = rc('chanh.ncp.showModelInfo', (item: ModelTreeItem) => modelManager.showModelInfo(item))

  const d9 = rc('chanh.startServer', () => serverManager.start())
  const d10 = rc('chanh.stopServer', () => serverManager.stop())
  const d11 = rc('chanh.downloadBinary', () => binaryManager.downloadBinary())
  const d12 = rc('chanh.openSettings', openSetting)
  const d13 = rc('chanh.selectChatModel', async () => modelManager.selectChatModel(chatParticipant))
  const d14 = rc('chanh.refreshServer', () => refreshEvents.fire())
  const d15 = rc('chanh.setMaxLoadedModels', () => modelManager.setMaxLoadedModels())
  const d16 = rc('chanh.selectServer', () => serverManager.selectServer())
  const d17 = rc('chanh.openServerUrl', openUrl)
  const d18 = rc('chanh.editServerPort', () => serverManager.editServerPort())

  const d19 = rc('chanh.toggleModelGrouping', () => p.toggleModelGrouping())
  const d20 = rc('chanh.toggleDlModelGrouping', () => p.toggleDlModelGrouping())
  const d21 = rc('chanh.toggleHotModels', () => p.toggleHotModels())

  const d22 = listenConfigsChange(serverManager)
  const d23 = lmcProvider.register()
  const d24 = window.registerFileDecorationProvider(new ModelDecorationProvider())

  context.subscriptions.push(
    d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14, d15, d16, d17,
    d18, d19, d20, d21, d22, d23, d24, serverManager
  )
  binaryManager.checkForUpdates()
}

// This method is called when your extension is deactivated
export function deactivate() {
  Logger.info('Lemonade extension deactivated')
}
