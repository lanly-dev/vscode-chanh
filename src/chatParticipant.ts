
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
  ConfigurationTarget,
  Disposable,
  ExtensionContext,
  Location,
  Uri
} from 'vscode'

import { LemonadeClient } from './lemonadeClient'
import { Logger } from './logger'
import { ModelManager } from './modelManager'
import { ServerManager } from './serverManager'
import { ServerStatus } from './interfaces'

import type { ChatFollowup, QuickPickItem } from 'vscode'
import type { ChatMessage, ChatStreamStats, LemonadeModel } from './interfaces'
import {
  closeOpenMarkdownFence, contextBudget, estimateTokens, formatSize, formatTurnFooter, shouldShowTokenStats
} from './utils'

// Handles VS Code chat requests by forwarding them to the Lemonade Server.
export class ChatParticipant implements Disposable {
  private readonly _subscriptions: Disposable[] = []
  private readonly _cancellationDisposables: Disposable[] = []

  private client: LemonadeClient
  private participant: VSCodeChatParticipant
  private selectedModel: string | undefined
  /** Context window (tokens) of the model resolved for this session. */
  private contextWindow = 8192
  /** Slash command of the last request; keys the follow-up suggestions. */
  private _lastCommand: string | undefined
  /** History turns predating the last /reset; not sent to the model. */
  private _ignoreHistoryBefore = 0

  constructor(
    private serverManager: ServerManager,
    private modelManager: ModelManager,
    extensionContext: ExtensionContext
  ) {
    this.client = new LemonadeClient(serverManager.activeServerUrl)

    // Create the chat participant
    this.participant = chat.createChatParticipant('CHANH_CHAT', this.handleRequest.bind(this))
    this.participant.iconPath = Uri.joinPath(
      extensionContext.extensionUri,
      'media',
      'chanh.svg'
    )

    // Suggested follow-ups after each answer, keyed to what was just asked.
    // Not offered after errors or a /reset (nothing to continue from).
    this.participant.followupProvider = {
      provideFollowups: (result) =>
        (result.errorDetails || result.metadata?.reset ? [] : this.buildFollowups())
    }

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

  /**
   * Get the model to use for chat, loading it on the server when needed.
   * Throws when listing/loading fails so the caller can surface the real
   * error instead of a generic "no model" message.
   */
  private async getModel(): Promise<string | undefined> {
    // Reuse the model already chosen earlier in this session.
    if (this.selectedModel) return this.selectedModel

    if (this.serverManager.status !== ServerStatus.RUNNING) return undefined

    const allModels = await this.client.listModels()
    const chatModels = allModels.filter((m) => ModelManager.capabilityFor(m, 'chat'))
    if (!allModels.length || !chatModels.length) {
      window.showWarningMessage('No chat-capable models found. Please download a chat model first.')
      return undefined
    }

    // Use the configured chat model when it still exists and is chat-capable;
    // a stale config (deleted model, switched server) falls back to the picker.
    const config = workspace.getConfiguration('chanh')
    const chatModel = config.get<string>('chatModel', '')
    if (chatModel) {
      const configured = chatModels.find((m) => m.id === chatModel)
      if (configured) return await this.loadForChat(configured)
      window.showWarningMessage(
        `Configured chat model '${chatModel}' is not available on the server. Pick another model.`
      )
    }

    // No usable chat model configured -> let the user pick which model to chat with.
    // Loaded models sort first and are marked, size is shown to tell quants
    // apart, and the choice is persisted like the palette command does.
    const loadedIds = new Set(
      (await this.client.getHealth().catch(() => undefined))?.all_models_loaded.map((m) => m.model_name) ?? []
    )
    type ModelPick = QuickPickItem & { modelId?: string }
    const loadedRank = (item: ModelPick): number => (item.description?.startsWith('$(check)') ? 0 : 1)
    const items: ModelPick[] = chatModels
      .map((m) => ({
        label: m.id,
        description: [loadedIds.has(m.id) ? '$(check) loaded' : undefined, formatSize(m.size)]
          .filter(Boolean).join(' · '),
        detail: ModelManager.getModelLabel(m),
        modelId: m.id
      }))
      // Sort is stable, so equal ranks keep catalog order.
      .sort((a, b) => loadedRank(a) - loadedRank(b))
    const selected = await window.showQuickPick<ModelPick>(items, {
      title: 'Select a model to chat with',
      placeHolder: 'Choose a model',
      ignoreFocusOut: true
    })
    if (!selected) return undefined
    const picked = chatModels.find((m) => m.id === selected.modelId)
    if (!picked) return undefined
    // Persist like the command-palette path, so the choice survives restarts
    // and future sessions skip the picker.
    await workspace.getConfiguration('chanh').update('chatModel', picked.id, ConfigurationTarget.Global)
    return await this.loadForChat(picked)
  }

  /** Load the model on the server (a no-op when already loaded) and remember it. */
  private async loadForChat(model: LemonadeModel): Promise<string> {
    await this.client.loadModel(model.id)
    this.selectedModel = model.id
    // Remember the window so history trimming can budget against it.
    this.contextWindow = model.context_length ?? model.max_context_window ?? 8192
    // Keep the tree view's loaded rows in sync with this implicit load.
    this.modelManager?.refreshTreeView()
    return model.id
  }

  /** Set the selected model. */
  setSelectedModel(model: string): void {
    this.selectedModel = model
    Logger.info(`Selected model for chat: ${model}`)
  }

  /**
   * Run a one-shot completion through the resolved chat model and return the
   * full response text. For commands that need a single generated draft
   * (release notes) rather than a chat turn: same model resolution — config,
   * picker, load — and the same client as the participant itself.
   */
  async completeWithChatModel(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const model = await this.getModel()
    signal?.throwIfAborted()
    if (!model) throw new Error('No chat model selected.')
    return this.client.chatCompletionStream({ model, messages }, () => { }, signal)
  }

  /**
   * Follow-up suggestions for the last answer. Keyed to the last slash
   * command so the suggestions read as natural next steps; no per-answer
   * content analysis — stable prompts a small local model can actually take.
   */
  private buildFollowups(): ChatFollowup[] {
    const common: ChatFollowup[] = [
      { prompt: 'Suggest improvements and point out edge cases', label: 'Suggest improvements' },
      { prompt: 'Make the answer more concise', label: 'More concise' }
    ]
    switch (this._lastCommand) {
      case 'fix':
        return [
          { prompt: 'Explain the fix step by step', label: 'Explain the fix' },
          { prompt: 'Write tests for the fixed code', label: 'Write tests' },
          ...common
        ]
      case 'explain':
        return [
          { prompt: 'Now refactor it for clarity', label: 'Refactor for clarity' },
          { prompt: 'Write unit tests for it', label: 'Write tests' },
          ...common
        ]
      case 'test':
        return [
          { prompt: 'Explain what each test covers', label: 'Explain tests' },
          { prompt: 'Add edge case tests', label: 'More edge cases' },
          ...common
        ]
      case 'doc':
        return [
          { prompt: 'Explain the documentation you wrote', label: 'Explain' },
          ...common
        ]
      case 'refactor':
        return [
          { prompt: 'Explain what changed and why', label: 'Explain changes' },
          { prompt: 'Write tests to verify behavior is unchanged', label: 'Verify with tests' },
          ...common
        ]
      default:
        return [
          { prompt: 'Explain the code above in more detail', label: 'Explain in more detail' },
          { prompt: 'Write unit tests for the code above', label: 'Write tests' },
          ...common
        ]
    }
  }

  /** Handle a chat request from VS Code. */
  private async handleRequest(
    request: ChatRequest,
    context: ChatContext,
    response: ChatResponseStream,
    token: CancellationToken
  ): Promise<ChatResult> {
    Logger.info(`Chat request received: "${request.prompt.substring(0, 100)}"`)

    // /reset starts fresh: keep the visible VS Code history but stop sending
    // turns that predate it. No model needed for this.
    if (request.command === 'reset') {
      this._ignoreHistoryBefore = context.history.length
      response.markdown('Context cleared — earlier messages will not be included in future requests. '
        + 'The chat view keeps them for reference.')
      return { metadata: { reset: true } }
    }
    this._lastCommand = request.command

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

    // Get the model to use; surface real failures (list/load errors, slot
    // conflicts) instead of a generic "no model" message. Loading can take a
    // while on CPU, so say what is happening instead of showing silence.
    let model: string | undefined
    try {
      if (!this.selectedModel) response.progress('Selecting and loading a chat model…')
      model = await this.getModel()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      Logger.error('Failed to get model for chat', err)
      response.markdown(`**Error:** ${message}`)
      return { errorDetails: { message } }
    }
    if (!model) {
      response.markdown('No chat model selected.')
      return { errorDetails: { message: 'No model available' } }
    }

    // Resolve explicit #file#/symbol references into one context message.
    const references = await this.buildReferenceContext(request)

    // Active editor context — skipped when its file was already attached above
    // (sending it twice wastes the same tokens twice). Note that context must
    // be re-sent every turn: /v1/chat/completions is stateless and VS Code's
    // history carries only prompts/replies, not what we splice in here.
    let editorContext: string | undefined
    const activeDoc = window.activeTextEditor?.document
    if (activeDoc && !references.files.has(activeDoc.uri.fsPath)) {
      editorContext = this.getEditorContext()
    }

    // Build the chat messages from history, trimmed to the model's window.
    const history = this.extractHistory(context)
    const trimmedHistory = await this.trimHistory(history, [
      LemonadeClient.buildSystemPrompt(request.command),
      references.text,
      editorContext,
      request.prompt
    ])
    const messages = LemonadeClient.toChatMessages(request.prompt, trimmedHistory, request.command)

    // Attach context as user turns right before the prompt — a wrapper would
    // nest code fences and break the markdown (and small models weigh the
    // turns closest to the question more).
    if (references.text) {
      messages.splice(messages.length - 1, 0, { role: 'user', content: references.text })
    }
    if (editorContext) {
      messages.splice(messages.length - 1, 0, { role: 'user', content: editorContext })
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
    // Small local models can spend a long time on prompt processing before
    // the first token arrives; surface that instead of showing silence.
    // Progress parts are replaced by the next one, so the stale message
    // disappears as soon as streaming starts.
    let firstToken = false
    const prefillTimer = setTimeout(() => {
      if (!firstToken) response.progress('Waiting for the first token (prompt processing)…')
    }, 1500)
    try {
      const stats: ChatStreamStats = {}
      const fullResponse = await this.client.chatCompletionStream(
        { model, messages },
        (tokenChunk) => {
          firstToken = true
          markBusy()
          response.markdown(tokenChunk)
        },
        this.createAbortSignal(token),
        undefined,
        stats
      )
      firstToken = true

      Logger.info(`Chat response complete (${fullResponse.length} chars)`)
      const footer = formatTurnFooter(stats, fullResponse.length)
      if (footer && shouldShowTokenStats()) {
        response.markdown(`${closeOpenMarkdownFence(fullResponse)}\n\n---\n${footer}`)
        Logger.info(`Token footer: ${footer}`)
      }
      return {}
    } catch (err) {
      // A cancelled turn is the user's own doing, not a failure — exit quietly
      // instead of rendering an error (mirrors lmcProvider's handling).
      if (token.isCancellationRequested) {
        Logger.info('Chat request cancelled by user')
        return {}
      }
      const message = err instanceof Error ? err.message : String(err)
      Logger.error('Chat completion failed', err)
      // Offer a one-click fix when the model's context size is too small.
      await this.modelManager.offerContextIncrease(model, err)
      // Show a short warning in chat; full details are in the extension log.
      const shortMessage = message.length > 160 ? message.slice(0, 160) + '…' : message
      response.markdown(`\n\n**Error:** ${shortMessage}`)
      return { errorDetails: { message: shortMessage } }
    } finally {
      clearTimeout(prefillTimer)
      // Dispose cancellation listeners so they cannot fire after the request
      // settles (avoiding double abort / stale controller handling).
      for (const disposable of this._cancellationDisposables) disposable.dispose()
      this._cancellationDisposables.length = 0
      this.modelManager?.refreshTreeView()
    }
  }

  /** Extract chat history from the VS Code chat context, honouring /reset. */
  private extractHistory(context: ChatContext): Array<{ role: string, content: string }> {
    const history: Array<{ role: string, content: string }> = []

    // Turns before the last /reset are skipped: VS Code owns the visible
    // history, we only control what gets sent to the model.
    for (const turn of context.history.slice(this._ignoreHistoryBefore)) {
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

  /** Max chars of any single reference attachment sent as context. */
  private static readonly MAX_REFERENCE_CHARS = 16384

  /**
   * Resolve the request's `#file#`/`#symbol#` references into one context
   * message. Whole-file `Uri`s are read in full (capped), `Location`
   * references contribute just their selected range, and plain strings are
   * passed through. Also returns the set of file paths covered so callers can
   * avoid attaching the same file twice.
   */
  private async buildReferenceContext(
    request: ChatRequest
  ): Promise<{ text?: string, files: Set<string> }> {
    const files = new Set<string>()
    const blocks: string[] = []

    for (const reference of request.references) {
      const value = reference.value
      try {
        if (value instanceof Uri) {
          const content = await this.readReferenceText(value)
          if (content === undefined) continue
          files.add(value.fsPath)
          blocks.push(this.formatReferenceBlock(value, content))
        } else if (value instanceof Location) {
          const document = await workspace.openTextDocument(value.uri)
          const content = document.getText(value.range)
          if (!content.trim()) continue
          files.add(value.uri.fsPath)
          const label = value.uri.fsPath.split(/[\\/]/).pop() ?? value.uri.fsPath
          const range = value.range
          blocks.push(
            `File: ${label} (lines ${range.start.line + 1}-${range.end.line + 1})\n` +
            this.fenceReference(content, document.languageId)
          )
        } else if (typeof value === 'string' && value.trim()) {
          // Symbol names and other plain-string values.
          blocks.push(`${reference.modelDescription ?? 'Reference'}: ${value}`)
        }
      } catch (err) {
        // A deleted/inaccessible reference must not fail the whole request.
        Logger.warn(`Failed to resolve chat reference: ${err}`)
      }
    }

    if (blocks.length === 0) return { files }
    return { text: `The user attached the following reference(s):\n\n${blocks.join('\n\n')}`, files }
  }

  /** Read a referenced file's text, or undefined when unreadable. */
  private async readReferenceText(uri: Uri): Promise<string | undefined> {
    try {
      const document = await workspace.openTextDocument(uri)
      return document.getText()
    } catch (err) {
      Logger.warn(`Cannot read referenced file ${uri.fsPath}: ${err}`)
      return undefined
    }
  }

  /** Format a whole-file reference as a fenced block, truncated when huge. */
  private formatReferenceBlock(uri: Uri, content: string): string {
    const label = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath
    // openTextDocument already mapped the language; reuse it when available.
    let languageId = 'plaintext'
    const doc = workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath)
    if (doc) languageId = doc.languageId
    return `File: ${label}\n${this.fenceReference(content, languageId)}`
  }

  /** Fence reference content, truncating to the cap with a visible note. */
  private fenceReference(content: string, languageId: string): string {
    const max = ChatParticipant.MAX_REFERENCE_CHARS
    const isTruncated = content.length > max
    const visible = isTruncated ? content.slice(0, max) : content
    const note = isTruncated
      ? `\n\n[Note: this reference was truncated to ${max} chars for context.]`
      : ''
    return `\`\`\`${languageId}\n${visible}\n\`\`\`${note}`
  }

  /**
   * Trim the oldest history turns when the assembled request would overflow
   * the model's input budget. Without this, long sessions fail with an opaque
   * server error (or the server silently drops the oldest tokens). Returns the
   * turns to send, with a note when anything was cut.
   */
  private async trimHistory(
    history: Array<{ role: string, content: string }>,
    fixedTexts: Array<string | undefined>
  ): Promise<Array<{ role: string, content: string }>> {
    if (history.length === 0) return history

    const { maxInput } = contextBudget(this.contextWindow)
    // Tokens consumed by everything that is not history: system prompt,
    // context attachments, and the prompt itself. The margin covers
    // per-message framing the tokenizer never sees.
    const fixedTokens = await this.countTokens(fixedTexts.filter((t): t is string => !!t).join('\n'))
    const budget = maxInput - fixedTokens - 32
    // A huge attachment can dwarf the window; trimming all history would not
    // help, so leave the request alone and let the server's own handling apply.
    if (budget <= 0) return history

    // One tokenize call for the whole history; only when it overflows do we
    // pay the per-turn round trips to find the cut point.
    const historyText = history.map((m) => `${m.role}: ${m.content}`).join('\n')
    if (await this.countTokens(historyText) <= budget) return history

    const kept: Array<{ role: string, content: string }> = []
    let used = 0
    for (let i = history.length - 1; i >= 0; i--) {
      const turn = history[i]
      const turnTokens = await this.countTokens(`${turn.role}: ${turn.content}`)
      if (used + turnTokens > budget) break
      used += turnTokens
      kept.unshift(turn)
    }
    const dropped = history.length - kept.length
    Logger.info(
      `Trimmed ${dropped} of ${history.length} chat history turn(s) to fit ` +
      `the ${this.contextWindow}-token window (${used}/${budget} tokens kept)`
    )
    if (dropped === 0) return history
    return [
      {
        role: 'user',
        content: `[Note: ${dropped} earlier message(s) were trimmed to fit the model's context window.]`
      },
      ...kept
    ]
  }

  /** Token count via the server, with a character estimate as fallback. */
  private async countTokens(text: string): Promise<number> {
    if (!text) return 0
    try {
      return await this.client.tokenize(text)
    } catch (err) {
      Logger.warn(`Cannot reach the server tokenizer, using character estimate: ${err}`)
      return estimateTokens(text)
    }
  }

  /**
   * Get the active editor's content as context, capped at 8192 chars with a
   * truncation note, labelled with the filename and language id. Returns a
   * complete chat message ready to send — callers must not wrap it again.
   */
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
