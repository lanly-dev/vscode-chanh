import * as vscode from 'vscode'
import { refreshEvents } from './events'
import { Logger } from './logger'
import { ServerStatus } from './interfaces'
import { ModelManager } from './modelManager'
import type { ChatCompletionRequest, ChatContentPart, ChatMessage, OpenAIMessageToolCall } from './interfaces'
import type { ToolCall, ToolDefinition } from './interfaces'
import type { ServerManager } from './serverManager'

/**
 * Completion budget for a context window: half the window, floored at 256 and
 * capped at 4096 so a wide window does not invite a rambling answer.
 */
function outputTokenBudget(contextWindow: number): number {
  return Math.min(Math.max(Math.floor(contextWindow / 2), 256), 4096)
}

/**
 * Split a context window between prompt and completion. Measured on llama.cpp,
 * the window is shared by the two (an uncapped turn stopped at exactly
 * `total_tokens == ctx_size`), so declaring each equal to the whole window
 * over-promises by 2x: the host assembles a prompt the completion no longer
 * fits alongside, and the server drops the oldest tokens without saying so.
 */
function contextBudget(contextWindow: number): { maxInput: number, maxOutput: number } {
  const maxOutput = outputTokenBudget(contextWindow)
  return { maxInput: Math.max(contextWindow - maxOutput, 1), maxOutput }
}

/** The `tool_choice` shapes the server accepts for a non-empty tool list. */
type ToolChoice = NonNullable<ChatCompletionRequest['tool_choice']>

/**
 * Translate the host's tool requirement into the server's `tool_choice`.
 *
 * One required tool stays the explicit function form, which is the shape a
 * model that "only support[s] a single tool when using this mode" expects.
 * Several required tools are forwarded as the bare `'required'` string —
 * llama.cpp accepts it and answers `finish_reason: 'tool_calls'` — instead of
 * the previous silent downgrade to `'auto'` that dropped the host's
 * requirement on the floor.
 *
 * The call site omits `tool_choice` entirely when no tools are offered, so the
 * `'auto'` returned for that case is never sent.
 */
function toolChoiceFor(required: boolean, tools: ToolDefinition[]): ToolChoice {
  if (!required || tools.length === 0) return 'auto'
  if (tools.length === 1) return { type: 'function', function: { name: tools[0].function.name } }
  return 'required'
}

/**
 * Whether a model belongs in the agent picker: a chat model that also
 * advertises tool calling. `chat` is one spelling of `capabilityFor`'s `llm`
 * group, and a differently-cased label must not drop a model with no error.
 */
function isToolCallingChatModel(labels: string[] | undefined): boolean {
  const ls = labels ?? []
  const isChat = ls.some((l) => ModelManager.capabilityFor(l) === 'llm')
  return isChat && ls.some((l) => l.toLowerCase() === 'tool-calling')
}

/**
 * Whether a model accepts image input. A substring test rather than
 * `capabilityFor`, which folds image *generation* into `image`; only `vision`
 * sets `imageInput`.
 */
function hasVisionLabel(labels: string[] | undefined): boolean {
  return (labels ?? []).some((l) => l.toLowerCase().includes('vision'))
}

/** Bound a logged fragment so one corrupt payload cannot flood the output channel. */
function previewText(text: string, limit = 200): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}... (${text.length} chars total)`
}

/**
 * Parse a streamed tool call. Missing, `null`, or `[]` arguments mean a
 * parameterless tool and stay silent. Anything else that is not a JSON object
 * cannot be delivered, so the call is dropped with a bounded copy of the raw
 * fragment logged rather than run with no arguments.
 */
function parseToolCall(raw: OpenAIMessageToolCall): ToolCall | undefined {
  const argsText: unknown = raw.function.arguments
  const text = typeof argsText === 'string' ? argsText.trim() : ''
  const call = (args: Record<string, unknown>): ToolCall => ({ id: raw.id, name: raw.function.name, args })

  if (!text) return call({})

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    Logger.warn(`Dropping tool call '${raw.function.name}' (${raw.id}): arguments are not valid JSON: ` +
      previewText(text))
    return undefined
  }

  // `null` and an empty array carry no argument data, so a parameterless tool
  // is the only sensible reading.
  if (parsed === null || (Array.isArray(parsed) && parsed.length === 0)) return call({})

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    Logger.warn(`Dropping tool call '${raw.function.name}' (${raw.id}): arguments are not a JSON object: ` +
      previewText(text))
    return undefined
  }

  return call(parsed as Record<string, unknown>)
}

function extractText(message: vscode.LanguageModelChatRequestMessage): string {
  const out: string[] = []
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) out.push(part.value)
    else if (part instanceof vscode.LanguageModelDataPart) {
      Logger.warn(`Dropping non-text part (mime=${part.mimeType}) in assistant message`)
    }
  }

  return out.join('')
}

/**
 * Extract the wire content of a user message: plain text when possible, or
 * OpenAI content parts when the message carries images (vision models).
 */
function extractContent(message: vscode.LanguageModelChatRequestMessage): string | ChatContentPart[] {
  let text = ''
  const images: ChatContentPart[] = []
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) text += part.value
    else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
      const b64 = Buffer.from(part.data).toString('base64')
      images.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${b64}` } })
    }
  }

  if (images.length === 0) return text
  return text ? [{ type: 'text', text }, ...images] : images
}

class ChanhLmcProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  readonly onDidChangeLanguageModelChatInformation?: vscode.Event<void>
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  private readonly _subscriptions: vscode.Disposable[] = []
  private disposed = false
  private modelManager?: ModelManager
  /**
   * Memoised server token counts, keyed by the exact text that was tokenized.
   * The host recounts the whole conversation on every request, so without this
   * each turn would re-tokenize every message.
   */
  private readonly tokenCounts = new Map<string, number>()
  private tokenCountFallbackWarned = false
  /**
   * The model whose tokenizer produced the memoised counts. `/v1/tokenize` is
   * not model-parameterised — it counts with whichever model the server has
   * loaded — so a count only holds while that model stays loaded.
   */
  private tokenCountModel?: string

  constructor(private serverManager: ServerManager) {
    this.onDidChangeLanguageModelChatInformation = this._onDidChange.event
    this._subscriptions.push(
      this.serverManager.onStatusChange((s) => {
        if (s === ServerStatus.RUNNING) {
          // A restart (or a reconnect to another server) discards the loaded
          // set, so no memoised count is trustworthy any more.
          this.noteTokenCountModel()
          this._onDidChange.fire()
        }
      }),
      this.serverManager.onActiveServerChange(() => this._onDidChange.fire())
    )
  }

  setModelManager(mm: ModelManager): void {
    this.modelManager = mm
  }

  refresh(): void {
    if (!this.disposed) this._onDidChange.fire()
  }

  /**
   * Repaint the tree so the loaded-model row tracks the request lifecycle:
   * `/v1/health` reports `is_busy`, so the row should read "busy" while a
   * completion runs and fall back to "idle" when it settles. The server only
   * flips to busy once the request is being served, so the caller re-fires
   * after the first token as well as at the end.
   */
  private syncRuntimeStatus(): void {
    if (!this.disposed) refreshEvents.fire()
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
    let models: Awaited<ReturnType<typeof client.listModels>>
    try {
      models = await client.listModels()
    } catch (err) {
      // Server down/unreachable: return empty so the picker shows "no models"
      // instead of an error/retry state. It refreshes on next status change.
      Logger.warn(`Could not list models for picker: ${err}`)
      return []
    }
    // Only chat models with tool-calling support are listed: the picker serves
    // agent mode, while plain chat models stay available through @chanh.
    const chatModels = models.filter((m) => isToolCallingChatModel(m.labels))
    Logger.info('Loaded ' + chatModels.length + ' downloaded tool-calling chat models')
    return chatModels.map((m): vscode.LanguageModelChatInformation => {
      const contextWindow = m.context_length ?? m.max_context_window ?? 8192
      const { maxInput, maxOutput } = contextBudget(contextWindow)
      const vision = hasVisionLabel(m.labels)
      return {
        id: m.id,
        name: m.id,
        family: m.id,
        version: '1.0.0',
        detail: vision ? 'vision' : undefined,
        tooltip: `${m.id}\nCapabilities: ${(m.labels ?? []).join(', ')}\n` +
          `Context: ${contextWindow.toLocaleString()} tokens (${maxOutput.toLocaleString()} reserved for output)`,
        maxInputTokens: maxInput,
        maxOutputTokens: maxOutput,
        capabilities: { toolCalling: true, imageInput: vision }
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
      // Avoid a `/v1/load` round-trip per agent loop iteration: skip when the
      // model is already loaded per `/v1/health`. Fall back to loading when
      // the health check fails so old/unreachable servers keep working.
      //
      // TODO: we might not need to check too aggressively if the model is already loaded,
      // maybe just try loading and catch errors
      let alreadyLoaded = false
      try {
        const health = await client.getHealth()
        alreadyLoaded = health.all_models_loaded.some((m) => m.model_name === model.id)
      } catch {
        alreadyLoaded = false
      }
      if (!alreadyLoaded) {
        await client.loadModel(model.id)
        // Agent mode loaded the model on demand, so the tree view's loaded
        // state is stale: ask it to re-query before repainting.
        refreshEvents.fire()
      } else Logger.info(`Model already loaded, skipping load: ${model.id}`)
      // Counts taken before this request were tokenized by whatever model was
      // loaded then, so they do not apply to the one being served now.
      this.noteTokenCountModel(model.id)
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
        const content = extractContent(m)
        if (content.length > 0) base.push({ role: 'user', content })
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
    const requireToolCall =
      options.toolMode === vscode.LanguageModelChatToolMode.Required && tools.length > 0
    const toolChoice = toolChoiceFor(requireToolCall, tools)

    const abort = new AbortController()
    const cancel = token.onCancellationRequested(() => abort.abort())
    // Streamed: the non-streaming request path has a 15s inactivity timeout
    // that local models blow past on large agent-mode prompts.
    const toolCalls: ToolCall[] = []
    // Paint the loaded row's busy state as the request starts, once the server
    // is actually serving, and again when it settles back to idle.
    let paintedBusy = false
    const markBusy = () => {
      if (paintedBusy) return
      paintedBusy = true
      this.syncRuntimeStatus()
    }
    this.syncRuntimeStatus()
    try {
      if (token.isCancellationRequested) return
      // Drop calls with unusable arguments, but track both halves of the
      // response: a turn whose only call is dropped must fail visibly.
      let reportedText = false
      let droppedCalls = 0
      await client.chatCompletionStream(
        {
          model: model.id,
          messages: base,
          max_tokens: this.outputTokenLimit(model, options),
          ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {})
        },
        (text) => {
          markBusy()
          reportedText = true
          progress.report(new vscode.LanguageModelTextPart(text))
        },
        abort.signal,
        (raw) => {
          const tc = parseToolCall(raw)
          if (tc) toolCalls.push(tc)
          else droppedCalls++
        }
      )
      for (const tc of toolCalls) progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.args))
      if (droppedCalls > 0 && toolCalls.length === 0 && !reportedText) {
        throw new Error(
          `The model returned ${droppedCalls} tool call(s) with arguments that could not be parsed ` +
          `and produced no text. The raw arguments are in the Chanh output channel; asking again ` +
          `usually lets the model correct them.`
        )
      }
      // `Required` is a contract, not a hint, but no local server enforces it:
      // llama.cpp's `--jinja` accepts `tool_choice` and still answers a prose
      // prompt with prose (measured: the same prompt returned the same text
      // under `auto` and `required`, once degenerating into a repeat loop with
      // no call at all). Text is still worth delivering, so an unmet
      // requirement is logged where a turn that produced nothing (above)
      // rejects.
      if (requireToolCall && toolCalls.length === 0) {
        Logger.warn(
          `'${model.id}' was told to call one of ${tools.length} tool(s) ` +
          `(tool_choice: ${typeof toolChoice === 'string' ? toolChoice : toolChoice.function.name}) ` +
          `and answered with ${reportedText ? 'text' : 'nothing'} instead` +
          `${droppedCalls > 0 ? `, besides ${droppedCalls} unusable tool call(s)` : ''}. ` +
          `Asking again usually produces a call.`
        )
      }
      Logger.info(`Language model response complete for ${model.id}`)
    } catch (err) {
      if (token.isCancellationRequested || abort.signal.aborted) return
      await this.modelManager?.offerContextIncrease(model.id, err)
      throw err
    } finally {
      cancel.dispose()
      this.syncRuntimeStatus()
    }
  }

  /** Character-based estimate, used when the server's tokenizer is unavailable. */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  /**
   * Count tokens with the server's tokenizer. `chars / 4` was wrong in both
   * directions, so the host sized requests incorrectly: measured against the
   * server, plain English was overcounted (129 chars -> 22 real tokens, but
   * estimated 33) while code, Windows paths, and Thai were undercounted
   * (Thai measured ~2x, code ~1.25-1.36x). Never throws: an unreachable server
   * falls back to the estimate so counting cannot break a request.
   */
  /**
   * Note which model the tokenizer is now counting with, dropping the memo when
   * it changed. The host counts tokens for the model it is about to call, but
   * `/v1/tokenize` answers with whichever model the server has loaded, so a
   * count collected for another model was never valid for this one.
   *
   * Limitation: the loaded model is only observed where a request ensures it,
   * or when the server restarts. Counts taken while a different model is loaded
   * stay cached until then, and two llms loaded at once cannot be told apart
   * here for the same reason.
   */
  private noteTokenCountModel(loadedModel?: string): void {
    if (loadedModel !== undefined && this.tokenCountModel === loadedModel) return
    if (this.tokenCounts.size > 0) {
      Logger.info(`Discarding ${this.tokenCounts.size} cached token count(s) counted by ` +
        `${this.tokenCountModel ?? 'the previously loaded model'}`)
    }
    this.tokenCountModel = loadedModel
    this.tokenCounts.clear()
  }

  private async countTokens(text: string): Promise<number> {
    if (!text) return 0
    const cached = this.tokenCounts.get(text)
    if (cached !== undefined) return cached

    let count: number
    try {
      count = await this.serverManager.client.tokenize(text)
    } catch (err) {
      if (!this.tokenCountFallbackWarned) {
        this.tokenCountFallbackWarned = true
        Logger.warn(`Cannot reach the server tokenizer, using the character estimate: ${err}`)
      }
      return this.estimateTokens(text)
    }

    // Bound the cache so a long session cannot retain every message forever.
    if (this.tokenCounts.size >= 512) this.tokenCounts.clear()
    this.tokenCounts.set(text, count)
    return count
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    if (typeof text === 'string') return this.countTokens(text)

    const parts: string[] = []
    let images = 0
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) parts.push(part.value)
      else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) images++
    }

    // Joining the parts keeps this to a single round trip; tokenizing each part
    // separately would only differ by a few boundary tokens.
    const textTokens = await this.countTokens(parts.join(''))

    // Servers tokenize images by resolution; ~1500/image is a safe estimate so
    // the host's context budget doesn't overflow on screenshots.
    return textTokens + images * 1500
  }

  /**
   * Cap the output of a single request. Uncapped, a turn generated until the
   * server's context filled up (measured on llama.cpp: 4056 of a 4096-token
   * window, ending in `finish_reason: length`), leaving the next agent
   * iteration no room for its history. A `max_tokens` from the host wins over
   * the budget this provider declared to it.
   */
  private outputTokenLimit(
    model: vscode.LanguageModelChatInformation,
    options: vscode.ProvideLanguageModelChatResponseOptions
  ): number {
    const requested: unknown = options.modelOptions?.max_tokens
    if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) return Math.floor(requested)
    // Prefer the completion share this provider declared to the host;
    // recomputing it from `maxInputTokens` (the window minus that share) is a
    // conservative fallback that halves the cap on small windows.
    return model.maxOutputTokens ?? outputTokenBudget(model.maxInputTokens)
  }

  dispose(): void {
    this.disposed = true
    this.tokenCounts.clear()
    while (this._subscriptions.length > 0) this._subscriptions.pop()?.dispose()
    this._onDidChange.dispose()
  }
}

export { ChanhLmcProvider }
