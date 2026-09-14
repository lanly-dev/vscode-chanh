import * as vscode from 'vscode'

import { BinaryManager } from './binaryManager'
import { ChatParticipant } from './chatParticipant'
import { ChanhLanguageModelProvider } from './langModelsProvider'
import { Logger } from './logger'
import { ModelDecorationProvider } from './modelDecorations'
import { ModelManager } from './modelManager'
import { ServerManager } from './serverManager'
import { ServerViewProvider } from './serverTreeview'

import { openSetting, openUrl } from './utils'
import { refreshEvents } from './events'

export async function activate(context: vscode.ExtensionContext) {
  const rc = vscode.commands.registerCommand

  // Initialize managers
  const binaryManager = new BinaryManager(context)
  const serverManager = new ServerManager(binaryManager)
  const provider = await createTreeView(context, serverManager)

  const modelManager = new ModelManager(serverManager, provider)
  const chatParticipant = new ChatParticipant(context, serverManager)

  // Expose Lemonade models in the native VS Code model picker (like Ollama).
  const lmProvider = new ChanhLanguageModelProvider(serverManager)

  const d1 = rc('chanh.startServer', () => serverManager.start())
  const d2 = rc('chanh.stopServer', () => serverManager.stop())
  const d3 = rc('chanh.downloadBinary', () => binaryManager.downloadBinary())
  const d4 = rc('chanh.openChat', ChatParticipant.openChat)
  const d5 = rc('chanh.openSettings', openSetting)
  const d6 = rc('chanh.downloadModel', (item: { modelId: string }) => modelManager.downloadModel(item))
  const d7 = rc('chanh.loadModel', (item: { modelId: string }) => modelManager.loadModel(item.modelId))
  const d8 = rc('chanh.unloadModel', (item: { modelId: string }) => modelManager.unloadModel(item.modelId))
  const d9 = rc('chanh.selectChatModel', async () => modelManager.selectChatModel(chatParticipant))
  const d10 = rc('chanh.refreshServer', () => refreshEvents.fire())
  const d11 = rc('chanh.setMaxLoadedModels', () => modelManager.setMaxLoadedModels())
  const d12 = rc('chanh.selectServer', () => serverManager.selectServer())
  const d13 = rc('chanh.openServerUrl', openUrl)
  const d14 = rc('chanh.editServerPort', () => serverManager.editServerPort())

  const d15 = rc('chanh.removeModel', async (item: { modelId: string }) => modelManager.deleteModel(item.modelId))
  const d16 = rc('chanh.retryModel', (item: { modelId: string }) => modelManager.startPull(item.modelId))
  const d17 = listenConfigsChange(serverManager)
  const d18 = lmProvider.register()
  const d19 = lmProvider
  const d20 = rc('chanh.toggleModelGrouping', () => provider.toggleModelGrouping())
  const d22 = rc('chanh.toggleDlModelGrouping', () => provider.toggleDlModelGrouping())
  const d21 = vscode.window.registerFileDecorationProvider(
    new ModelDecorationProvider()
  )

  context.subscriptions.push(
    d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14, d15, d16, d17, d18,
    d19, d20, d21, d22
  )
  binaryManager.checkForUpdates()
}

function listenConfigsChange(serverManager: ServerManager) {
  return vscode.workspace.onDidChangeConfiguration(async (e) => {
    const settings = ['chanh.targetServer', 'chanh.customServerUrl', 'chanh.standalonePort', 'chanh.embeddedPort']

    if (settings.some((setting) => e.affectsConfiguration(setting))) {
      serverManager.applyConfiguredServerMode()

      // When the user switches away from embedded mode, stop the local embedded process
      // it's no longer the active server.
      const config = vscode.workspace.getConfiguration('chanh')
      const newMode = config.get<string>('targetServer', 'standalone')
      // TODO: Check if stop before switching away from embedded mode
      if (newMode !== 'embedded') await serverManager.stop()

      refreshEvents.fire()
    }
  })
}

// Register tree view for Lemonade status
async function createTreeView(context: vscode.ExtensionContext, serverManager: ServerManager) {
  const provider = new ServerViewProvider(context, serverManager)
  vscode.window.createTreeView('CHANH_TREEVIEW', { treeDataProvider: provider, showCollapseAll: true })
  await refreshEvents.fire()
  return provider
}

// This method is called when your extension is deactivated
export function deactivate() {
  Logger.info('Lemonade extension deactivated')
}
