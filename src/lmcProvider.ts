import * as vscode from 'vscode'
import { Logger } from './logger'
import { ServerStatus } from './interfaces'
import type { ChatMessage, OpenAIMessageToolCall } from './interfaces'
import type { ToolCall, ToolDefinition } from './interfaces'
import type { ModelManager } from './modelManager'
import type { ServerManager } from './serverManager'

interface BuiltinTool {
  name: string
  description: string
  parameters: object
  execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>
}

const BUILTIN_TOOLS: BuiltinTool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file content or an error.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file to read' } },
      required: ['path']
    },
    execute: async (args, signal) => {
      if (signal.aborted) return ''
      const raw = String(args.path ?? '')
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(raw))
        return doc.getText()
      } catch (err) {
        return JSON.stringify({ error: String(err) })
      }
    }
  },
  {
    name: 'list_files',
    description: 'List entries in a directory. Returns one path per line.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path' } },
      required: ['path']
    },
    execute: async (args, signal) => {
      if (signal.aborted) return ''
      const raw = String(args.path ?? '')
      try {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(raw))
        return entries.map((e) => e[0]).join('\n')
      } catch (err) {
        return JSON.stringify({ error: String(err) })
      }
    }
  }
]

function toolDefs(): ToolDefinition[] {
  return BUILTIN_TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

function runToolCall(tc: ToolCall, signal: AbortSignal): Promise<string> {
  const tool = BUILTIN_TOOLS.find((t) => t.name === tc.name)
  if (!tool) return Promise.resolve(JSON.stringify({ error: 'Unknown tool: ' + tc.name }))
  try {
    return tool.execute(tc.args, signal)
  } catch (err) {
    return Promise.resolve(JSON.stringify({ error: String(err) }))
  }
}

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

function toRole(role: vscode.LanguageModelChatMessageRole): ChatMessage['role'] {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant'
  return 'user'
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
        const chunks: string[] = []
        if (text.length > 0) chunks.push(text)
        for (const part of m.content) {
          if (part instanceof vscode.LanguageModelToolResultPart) {
            for (const c of part.content) {
              if (c instanceof vscode.LanguageModelTextPart) chunks.push(c.value)
              else chunks.push(String(c))
            }
          }
        }
        const content = chunks.join('\n')
        if (content.length > 0) base.push({ role: 'user', content })
      }
    }

    const hostTools: ToolDefinition[] = (options.tools ?? []).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema ?? {} }
    }))
    const tools: ToolDefinition[] = [...hostTools, ...toolDefs()]
    const singleHostTool = options.toolMode === vscode.LanguageModelChatToolMode.Required && hostTools.length === 1
    const toolChoice = singleHostTool
      ? { type: 'function' as const, function: { name: hostTools[0].function.name } }
      : ('auto' as const)

    const current: ChatMessage[] = [...base]
    const abort = new AbortController()
    const cancel = token.onCancellationRequested(() => abort.abort())
    try {
      for (let i = 0; i < 10; i++) {
        if (token.isCancellationRequested || abort.signal.aborted) break
        const response = await client.chatCompletion({
          model: model.id,
          messages: current,
          stream: false,
          tools,
          tool_choice: toolChoice
        })
        const msg = response.choices[0]?.message
        if (!msg) continue
        if (msg.content) progress.report(new vscode.LanguageModelTextPart(msg.content))
        const rawCalls = msg.tool_calls ?? []
        if (rawCalls.length === 0) break
        for (const raw of rawCalls) {
          if (token.isCancellationRequested || abort.signal.aborted) break
          const tc = parseToolCall(raw)
          if (!tc) continue
          progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.args))
          const result = await runToolCall(tc, abort.signal)
          current.push({ role: 'tool', content: result, tool_call_id: tc.id })
        }
      }
      Logger.info(`Language model response complete for ${model.id}`)
    } catch (err) {
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
