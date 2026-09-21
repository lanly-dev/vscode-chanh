import * as vscode from 'vscode'
import { Logger } from './logger'
import { ServerStatus } from './interfaces'
import type { ChatMessage, OpenAIMessageToolCall } from './interfaces'
import type { ToolCall, ToolDefinition } from './interfaces'
import type { ModelManager } from './modelManager'
import type { ServerManager } from './serverManager'

function parseToolCall(raw: OpenAIMessageToolCall): ToolCall | undefined {
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(raw.function.arguments || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
  } catch {
    args = {}
  }
  return { id: raw.id, name: raw.function.name, args }
}

function extractText(message: vscode.LanguageModelChatRequestMessage): string {
  const out: string[] = []
  for (const part of message.content)
    if (part instanceof vscode.LanguageModelTextPart) out.push(part.value)

  return out.join('')
}

class ChanhLmcProvider implements vscode.LanguageModelChatProvider {
  readonly onDidChangeLanguageModelChatInformation?: vscode.Event<void>
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  private disposed = false
  private modelManager?: ModelManager

  constructor(private serverManager: ServerManager) {
    this.onDidChangeLanguageModelChatInformation = this._onDidChange.event
    this.serverManager.onStatusChange((s) => {
      if (s === ServerStatus.RUNNING) this._onDidChange.fire()
    })
    this.serverManager.onActiveServerChange(() => this._onDidChange.fire())
  }

  setModelManager(mm: ModelManager): void {
    this.modelManager = mm
  }

  refresh(): void {
    if (!this.disposed) this._onDidChange.fire()
  }

  register(): vscode.Disposable {
    const disposable = vscode.lm.registerLanguageModelChatProvider('chanh', this)
    Logger.info('Registered Chanh language model provider')
    return disposable
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const client = this.serverManager.client
    const models = await client.listModels()
    const chatModels = models.filter((m) => m.labels?.includes('chat'))
    Logger.info('Loaded ' + chatModels.length + ' downloaded chat models')
    return chatModels.map((m): vscode.LanguageModelChatInformation => {
      const maxInput = m.context_length ?? m.max_context_window ?? 8192
      return {
        id: m.id,
        name: m.id + ' (' + (m.recipe ?? 'unknown') + ')',
        family: m.id,
        version: '1.0.0',
        maxInputTokens: maxInput,
        maxOutputTokens: maxInput,
        capabilities: { toolCalling: m.labels?.includes('tool-calling') ?? false }
      }
    })
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    await this.serverManager.ensureRunning()
    const client = this.serverManager.client
    try {
      await client.loadModel(model.id)
    } catch (err) {
      Logger.warn(`Could not preload '${model.id}': ${err}`)
    }

    const base: ChatMessage[] = []
    for (const m of messages) {
      const text = extractText(m)
      if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
        const calls: OpenAIMessageToolCall[] = []
        for (const part of m.content) {
          if (part instanceof vscode.LanguageModelToolCallPart) {
            calls.push({
              id: part.callId,
              type: 'function',
              function: { name: part.name, arguments: JSON.stringify(part.input) }
            })
          }
        }
        if (calls.length > 0) base.push({ role: 'assistant', content: text, tool_calls: calls })
        else if (text.length > 0) base.push({ role: 'assistant', content: text })
      } else {
        if (text.length > 0) base.push({ role: 'user', content: text })
        // Tool results must be sent as `tool` role messages keyed by call id,
        // otherwise tool-calling models lose track of which call they answer.
        for (const part of m.content) {
          if (part instanceof vscode.LanguageModelToolResultPart) {
            const chunks: string[] = []
            for (const c of part.content) {
              if (c instanceof vscode.LanguageModelTextPart) chunks.push(c.value)
              else chunks.push(String(c))
            }
            base.push({ role: 'tool', content: chunks.join('\n'), tool_call_id: part.callId })
          }
        }
      }
    }

    // The host (VS Code agent mode) owns the tools and the tool-call loop.
    // This provider is a thin translator: forward the host's tools, run a
    // single completion, and report text + tool calls back to the host.
    const tools: ToolDefinition[] = (options.tools ?? []).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema ?? {} }
    }))
    const requireSingleTool = options.toolMode === vscode.LanguageModelChatToolMode.Required && tools.length === 1
    const toolChoice = requireSingleTool
      ? { type: 'function' as const, function: { name: tools[0].function.name } }
      : ('auto' as const)

    const abort = new AbortController()
    const cancel = token.onCancellationRequested(() => abort.abort())
    // Streamed: the non-streaming request path has a 15s inactivity timeout
    // that local models blow past on large agent-mode prompts.
    const toolCalls: ToolCall[] = []
    try {
      if (token.isCancellationRequested) return
      await client.chatCompletionStream(
        {
          model: model.id,
          messages: base,
          ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {})
        },
        (text) => progress.report(new vscode.LanguageModelTextPart(text)),
        abort.signal,
        (raw) => {
          const tc = parseToolCall(raw)
          if (tc) toolCalls.push(tc)
        }
      )
      for (const tc of toolCalls)
        progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.args))
      Logger.info(`Language model response complete for ${model.id}`)
    } catch (err) {
      if (token.isCancellationRequested || abort.signal.aborted) return
      await this.modelManager?.offerContextIncrease(model.id, err)
      throw err
    } finally {
      cancel.dispose()
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const str = typeof text === 'string' ? text : extractText(text)
    return Math.ceil(str.length / 4)
  }

  dispose(): void {
    this.disposed = true
    this._onDidChange.dispose()
  }
}

export { ChanhLmcProvider }
