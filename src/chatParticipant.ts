
import {
  chat,
  window,
  workspace,
  CancellationToken,
  ChatContext,
  ChatParticipant as VSCodeChatParticipant,
  ChatRequest,
  ChatRequestTurn,
  ChatResponseStream,
  ChatResponseTurn,
  ChatResult,
  Disposable,
  ThemeIcon
} from 'vscode'

import { LemonadeClient } from './lemonadeClient'
import { Logger } from './logger'
import { ModelManager } from './modelManager'
import { ServerManager } from './serverManager'
import { ServerStatus } from './interfaces'

import type { ChatMessage, ChatStreamStats } from './interfaces'
import { closeOpenMarkdownFence, formatTurnFooter, shouldShowTokenStats } from './utils'

// Handles VS Code chat requests by forwarding them to the Lemonade Server.
export class ChatParticipant implements Disposable {
  private readonly _subscriptions: Disposable[] = []
  private readonly _cancellationDisposables: Disposable[] = []

  private client: LemonadeClient
  private participant: VSCodeChatParticipant
  private selectedModel: string | undefined

  constructor(private serverManager: ServerManager, private modelManager: ModelManager) {
    this.client = new LemonadeClient(serverManager.activeServerUrl)

    // Create the chat participant
    this.participant = chat.createChatParticipant('CHANH_CHAT', this.handleRequest.bind(this))
    this.participant.iconPath = new ThemeIcon('sparkle')

    // Update client when server status changes to running
    this._subscriptions.push(
      this.serverManager.onStatusChange((status) => {
        if (status !== ServerStatus.RUNNING) return
        this.updateClientForActiveServer()
        this.selectedModel = undefined
      }),
      this.serverManager.onActiveServerChange(() => {
        this.updateClientForActiveServer()
        this.selectedModel = undefined
      })
    )
  }

  /** Update the client to point at the currently active server. */
  private updateClientForActiveServer(): void {
    const url = this.serverManager.activeServerUrl
    this.client.setBaseUrl(url)
    Logger.info(`Chat client pointing to: ${url}`)
  }

  /** Get the model to use for chat. */
  private async getModel(): Promise<string | undefined> {
    // Reuse the model already chosen earlier in this session.
    if (this.selectedModel) return this.selectedModel

    // Use the configured chat model if one is set.
    const config = workspace.getConfiguration('chanh')
    const chatModel = config.get<string>('chatModel', '')

    if (chatModel) {
      this.selectedModel = chatModel
      return chatModel
    }

    if (this.serverManager.status !== ServerStatus.RUNNING) return undefined

    try {
      // No chat model configured -> let the user pick which model to chat with.
      const allModels = await this.client.listModels()
      const chatModels = allModels.filter((m) => ModelManager.capabilityFor(m, 'chat'))
      const msg = 'No chat-capable models found. Please download a chat model first.'
      if (!allModels.length || !chatModels.length) {
        window.showWarningMessage(msg)
        return undefined
      }

      const items = chatModels.map((m) => ({ label: m.id, description: ModelManager.getModelLabel(m) }))
      const selected = await window.showQuickPick(items, {
        title: 'Select a model to chat with',
        placeHolder: 'Choose a model',
        ignoreFocusOut: true
      })

      if (selected) {
        this.selectedModel = selected.label
        // Load the model if not already loaded
        await this.client.loadModel(selected.label)
        // Keep the tree view's loaded rows in sync with this implicit load.
        this.modelManager?.refreshTreeView()
        return selected.label
      }
    } catch (err) {
      Logger.error('Failed to get model for chat', err)
    }
    return undefined
  }

  /** Set the selected model. */
  setSelectedModel(model: string): void {
    this.selectedModel = model
    Logger.info(`Selected model for chat: ${model}`)
  }

  /** Handle a chat request from VS Code. */
  private async handleRequest(
    request: ChatRequest,
    context: ChatContext,
    response: ChatResponseStream,
    token: CancellationToken
  ): Promise<ChatResult> {
    Logger.info(`Chat request received: "${request.prompt.substring(0, 100)}"`)

    if (this.serverManager.status !== ServerStatus.RUNNING) {
      const start = await window.showInformationMessage(
        'Lemonade Server is not running. Start it now?',
        'Start Server',
        'Cancel'
      )
      if (start === 'Start Server') {
        const started = await this.serverManager.start()
        if (!started) {
          response.markdown('Failed to start Lemonade Server. Please check the output for details.')
          return { errorDetails: { message: 'Server failed to start' } }
        }
      } else {
        response.markdown('Lemonade Server is not running. Please start it using the "Chanh: Start Server" command.')
        return { errorDetails: { message: 'Server not running' } }
      }
    }

    // Get the model to use
    const model = await this.getModel()
    if (!model) {
      response.markdown('No model is loaded.')
      return { errorDetails: { message: 'No model available' } }
    }

    // Build the chat messages from history
    const history = this.extractHistory(context)
    const messages = LemonadeClient.toChatMessages(request.prompt, history, request.command)

    // Add context from active editor if available
    const editorContext = this.getEditorContext()
    if (editorContext) {
      const contextMessage: ChatMessage = {
        role: 'system',
        content: `The user has the following code open in their editor:\n\n\`\`\`\n${editorContext}\n\`\`\``
      }
      messages.splice(1, 0, contextMessage)
    }

    // Stream the response. The server reports per-model `is_busy`, so repaint
    // the tree around the stream to keep the loaded row's busy/idle honest.
    let paintedBusy = false
    const markBusy = () => {
      if (paintedBusy) return
      paintedBusy = true
      this.modelManager?.refreshTreeView()
    }
    this.modelManager?.refreshTreeView()
    try {
      const stats: ChatStreamStats = {}
      const fullResponse = await this.client.chatCompletionStream(
        { model, messages },
        (tokenChunk) => {
          markBusy()
          response.markdown(tokenChunk)
        },
        this.createAbortSignal(token),
        undefined,
        stats
      )

      Logger.info(`Chat response complete (${fullResponse.length} chars)`)
      const footer = formatTurnFooter(stats, fullResponse.length)
      if (footer && shouldShowTokenStats()) {
        response.markdown(`${closeOpenMarkdownFence(fullResponse)}\n\n---\n${footer}`)
        Logger.info(`Token footer: ${footer}`)
      }
      return {}
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      Logger.error('Chat completion failed', err)
      // Offer a one-click fix when the model's context size is too small.
      await this.modelManager.offerContextIncrease(model, err)
      response.markdown(`\n\n**Error:** ${message}`)
      return { errorDetails: { message } }
    } finally {
      // Dispose cancellation listeners so they cannot fire after the request
      // settles (avoiding double abort / stale controller handling).
      for (const disposable of this._cancellationDisposables) disposable.dispose()
      this._cancellationDisposables.length = 0
      this.modelManager?.refreshTreeView()
    }
  }

  /** Extract chat history from the VS Code chat context. */
  private extractHistory(context: ChatContext): Array<{ role: string, content: string }> {
    const history: Array<{ role: string, content: string }> = []

    for (const turn of context.history) {
      // Check if it's a request turn (user message)
      if (turn instanceof ChatRequestTurn) {
        const requestTurn = turn as ChatRequestTurn
        history.push({ role: 'user', content: requestTurn.prompt })
      } else if (turn instanceof ChatResponseTurn) {
        // It's a response turn (assistant message)
        const responseTurn = turn as ChatResponseTurn
        // Get the response text
        const responseText = responseTurn.response
          .map((part) => {
            if (typeof part === 'string') return part
            if (part && typeof part === 'object' && 'value' in part) return String(part.value)
            return ''
          })
          .join('')
        if (responseText) history.push({ role: 'assistant', content: responseText })
      }
    }
    return history
  }

  /** Get the active editor's content as context, capped at 8192 chars with a
   *  truncation note, labelled with the filename and language id. */
  private getEditorContext(): string | undefined {
    const editor = window.activeTextEditor
    if (!editor) return undefined

    const document = editor.document
    const fileName = document.fileName.split(/[\\/]/).pop() ?? document.fileName
    const languageId = document.languageId
    const content = editor.selection.isEmpty
      ? document.getText()
      : document.getText(editor.selection)

    const maxLength = 8192
    const isTruncated = content.length > maxLength
    const visible = isTruncated ? content.slice(0, maxLength) : content
    const note = isTruncated
      ? `\n\n[Note: the open file was truncated to ${maxLength} chars for context.]`
      : ''

    return `The user has the following file open in their editor:\n\n` +
      `File: ${fileName} | Language: ${languageId}\n\n` +
      `\`\`\`\n${visible}\n\`\`\`${note}`
  }

  /** Create an AbortSignal from a VS Code CancellationToken. */
  private createAbortSignal(token: CancellationToken): AbortSignal {
    const controller = new AbortController()
    const cancellationDisposable = token.onCancellationRequested(() => {
      Logger.info('Chat request cancelled by user')
      controller.abort()
    })
    this._cancellationDisposables.push(cancellationDisposable)
    return controller.signal
  }

  dispose(): void {
    this.participant.dispose()
    while (this._subscriptions.length > 0) this._subscriptions.pop()?.dispose()
  }
}
