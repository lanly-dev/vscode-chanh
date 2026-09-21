import * as vscode from 'vscode'

import { Logger } from './logger'
import { ModelManager } from './modelManager'
import { ServerStatus } from './interfaces'

import type { ChatMessage, LemonadeModel } from './interfaces'
import type { ServerManager } from './serverManager'

/**
 * Registers Lemonade Server models with the VS Code Language Model API
 * (`vscode.lm.registerLanguageModelChatProvider`) so they show up in the
 * native VS Code model picker under the "Chanh" provider
 */
export class ChanhLmcProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  /** Fired when the available model list may have changed. */
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>

  private readonly _onDidChange = new vscode.EventEmitter<void>()
  private disposed = false
  /** Injected after construction so context-overflow errors can offer a fix. */
  private modelManager?: ModelManager

  /** Late-bind the ModelManager (it needs this provider at construction). */
  setModelManager(modelManager: ModelManager): void {
    this.modelManager = modelManager
  }

  constructor(private serverManager: ServerManager) {
    this.onDidChangeLanguageModelChatInformation = this._onDidChange.event

    // Re-query models whenever the server status or selection changes so the
    // picker stays up to date.
    this.serverManager.onStatusChange((status) => {
      if (status === ServerStatus.RUNNING) this._onDidChange.fire()
    })
    this.serverManager.onActiveServerChange(() => this._onDidChange.fire())
  }

  /**
   * Ask VS Code to re-query the model list so the picker picks up changed
   * metadata (e.g. a model's context size after `ctx_size` is updated).
   */
  refresh(): void {
    if (!this.disposed) this._onDidChange.fire()
  }

  /** Register the provider with VS Code. Returns the disposable to add to subscriptions. */
  register(): vscode.Disposable {
    const registration = vscode.lm.registerLanguageModelChatProvider('chanh', this)
    Logger.info('Registered Chanh language model provider')
    return registration
  }

  /** List available (downloaded, chat-capable) models from the Lemonade Server. */
  provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    void options
    return this.listModelInformation(token)
  }

  private async listModelInformation(
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (this.disposed || token.isCancellationRequested) return []

    let models
    try {
      // Use the server-bound client so the active server (lemonade,
      // lemond, or custom) is respected.
      const client = this.serverManager.client
      const all = await client.listModels()
      // Only expose downloaded chat models — the picker should behave like
      models = all.filter((m) => m.downloaded !== false && ChanhLmcProvider.hasLabel(m, 'chat'))
    } catch (err) {
      // Server offline or unreachable — VS Code will retry via our change event.
      Logger.warn(`Could not list Lemonade models for the model picker: ${err}`)
      return []
    }

    return models.map((m) => {
      const contextWindow = m.context_length ?? 4096
      const maxOutputTokens = Math.min(1024, Math.max(256, Math.floor(contextWindow / 4)))

      return {
        id: m.id,
        name: m.id,
        family: m.recipe ?? 'llamacpp',
        tooltip: `Local model served by Lemonade Server (${this.serverManager.activeServerName})`,
        detail: ModelManager.getModelLabel(m),
        version: String(m.created ?? 1),
        maxInputTokens: contextWindow - maxOutputTokens,
        maxOutputTokens,
        // Lemonade tags tool-capable and vision models with the `tool-calling`
        // and `vision` labels. These must be mapped through: the VS Code picker
        // hides models without tool calling in Agent mode and in inline chat,
        // so hardcoding them off keeps the models out of the dropdown.
        capabilities: {
          toolCalling: ChanhLmcProvider.hasLabel(m, 'tool-calling'),
          imageInput: ChanhLmcProvider.hasLabel(m, 'vision')
        }
      }
    })
  }

  /** Stream a chat completion from the Lemonade Server for the given model. */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    void options
    const client = this.serverManager.client

    const health = await client.getHealth()
    const isLoaded = health.all_models_loaded.some((loaded) => loaded.model_name === model.id)
    if (!isLoaded) {
      Logger.info(`Loading language model selected in VS Code: ${model.id}`)
      await client.loadModel(model.id)
      // A freshly loaded model may report a different effective context size,
      // so have VS Code re-query the picker metadata.
      this.refresh()
    }

    const chatMessages: ChatMessage[] = messages.map((m) => ({
      role: ChanhLmcProvider.toRole(m.role),
      content: ChanhLmcProvider.extractText(m)
    })).filter((m) => m.content.length > 0)

    const abortController = new AbortController()
    const subscription = token.onCancellationRequested(() => abortController.abort())

    try {
      await client.chatCompletionStream(
        { model: model.id, messages: chatMessages },
        (chunk) => progress.report(new vscode.LanguageModelTextPart(chunk)),
        abortController.signal
      )
      Logger.info(`Language model response complete for ${model.id}`)
    } catch (err) {
      // Offer a one-click fix when the model's context size is too small,
      // then rethrow so VS Code still surfaces the failure.
      await this.modelManager?.offerContextIncrease(model.id, err)
      throw err
    } finally {
      subscription.dispose()
    }
  }

  /**
   * Rough token estimate (~4 chars per token). Lemonade does not expose a
   * tokenization endpoint, so an approximation keeps the prompt budget sane.
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    void model
    void token
    const str = typeof text === 'string' ? text : ChanhLmcProvider.extractText(text)
    return Math.ceil(str.length / 4)
  }

  /** Whether a model carries the given Lemonade label (case-insensitive). */
  private static hasLabel(model: LemonadeModel, label: string): boolean {
    return (model.labels ?? []).some((l) => l.toLowerCase() === label)
  }

  /** Map a VS Code language model role to an OpenAI-style chat role. */
  private static toRole(role: vscode.LanguageModelChatMessageRole): ChatMessage['role'] {
    if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant'
    // The Language Model API only exposes User/Assistant; system-style content
    // arrives as User and is forwarded as such.
    return 'user'
  }

  /** Extract plain text from a VS Code language model request message. */
  private static extractText(message: vscode.LanguageModelChatRequestMessage): string {
    return message.content
      .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
      .join('')
  }

  dispose(): void {
    this.disposed = true
    this._onDidChange.dispose()
  }
}
