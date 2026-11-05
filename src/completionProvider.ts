import {
  CancellationToken,
  Disposable,
  InlineCompletionContext,
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionList,
  languages,
  Position,
  Range,
  TextDocument,
  window,
  workspace,
  WorkspaceConfiguration
} from 'vscode'

import { LemonadeClient } from './lemonadeClient'
import { Logger } from './logger'
import { ModelManager } from './modelManager'
import { ServerManager } from './serverManager'
import { ServerStatus } from './interfaces'
import { cleanCompletion } from './completionText'

import type { ChatMessage } from './interfaces'

/** Keystrokes settle for this long before a request is even considered. */
const DEBOUNCE_MS = 300
/** Hard cap on one completion request, debounce included is separate. */
const REQUEST_TIMEOUT_MS = 3000
/** Context window sent to the model: lines before / after the cursor. */
const PREFIX_LINES = 60
const SUFFIX_LINES = 20
/** Model resolution hits the server (list + health); cache it briefly. */
const MODEL_CACHE_MS = 10000
/** Output cap: ghost text is a line or two, not a file. */
const MAX_COMPLETION_TOKENS = 128

const WORD_CHAR = /[A-Za-z0-9_]/

/**
 * Copilot-style inline (ghost text) completions from the local Lemonade
 * server, via VS Code's InlineCompletionItemProvider API.
 *
 * Opt-in through `chanh.completions.enabled` (default off): while typing,
 * the code around the cursor is sent to the user's own local server, so the
 * feature stays off until the user asks for it. Everything about this
 * provider is fail-silent — a down server, a missing model, a timeout, or
 * an unusable response all just mean "no suggestion", never an error in
 * the editor. Failures are noted in the Chanh output channel only.
 *
 * Cost control: keystrokes are debounced, superseded requests are aborted,
 * resolution of which model to use is cached, and the model is only ever
 * USED when it is already loaded on the server — a keystroke must never
 * trigger a (potentially minutes-long) model load.
 *
 * Diagnostics: fail-silent in the editor must not mean invisible. Every
 * skip reason is logged to the Chanh output channel — once per distinct
 * reason, so constant provide() calls cannot spam it — plus the resolved
 * model whenever it changes and the first success after a failure streak.
 * The `Chanh: Test Ghost Text Completion` command runs the same stages
 * explicitly and reports each one, for when the log alone is not enough.
 */
export class GhostTextProvider implements InlineCompletionItemProvider, Disposable {
  private client: LemonadeClient
  private readonly subscriptions: Disposable[] = []
  private inFlight: AbortController | undefined
  private cache: { key: string, text: string } | undefined
  private modelCache: { model: string | undefined, at: number } | undefined
  /** Last skip reason handed to the log; a repeat of it stays unlogged. */
  private lastSkipReason: string | undefined
  /** Why the latest fresh model resolution found nothing (facts included). */
  private noModelReason: string | undefined
  /** Model the latest fresh resolution picked; logged when it changes. */
  private lastResolvedModel: string | undefined
  /** Model behind the last logged success line. */
  private lastSuccessModel: string | undefined

  constructor(private serverManager: ServerManager) {
    // Same plumbing as the chat participant: own a client, keep its base
    // URL pointed at the active server as servers come, go, and switch.
    this.client = new LemonadeClient(serverManager.activeServerUrl)
    this.subscriptions.push(
      serverManager.onStatusChange((status) => {
        if (status === ServerStatus.RUNNING) this.client.setBaseUrl(serverManager.activeServerUrl)
        this.modelCache = undefined
      }),
      serverManager.onActiveServerChange(() => {
        this.client.setBaseUrl(serverManager.activeServerUrl)
        this.modelCache = undefined
      }),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('chanh')) this.modelCache = undefined
      })
    )
  }

  /** Register with VS Code for every file-like document. */
  register(): Disposable {
    const disposable = languages.registerInlineCompletionItemProvider({ pattern: '**' }, this)
    Logger.info('Registered Chanh ghost-text completion provider')
    return disposable
  }

  async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    _context: InlineCompletionContext,
    token: CancellationToken
  ): Promise<InlineCompletionList | undefined> {
    try {
      return await this.provide(document, position, token)
    } catch (err) {
      // Last-resort guard: whatever went wrong, the editor just shows no
      // ghost text. The detail goes to the output channel, never the UI.
      Logger.info(`Ghost text skipped: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  private async provide(
    document: TextDocument,
    position: Position,
    token: CancellationToken
  ): Promise<InlineCompletionList | undefined> {
    const config = workspace.getConfiguration('chanh')
    if (!config.get<boolean>('completions.enabled', false)) {
      return this.skip('completions disabled (chanh.completions.enabled is off)')
    }
    if (document.uri.scheme === 'output') {
      return this.skip('documents with the "output" scheme are excluded')
    }
    if (this.serverManager.status !== ServerStatus.RUNNING) {
      return this.skip(`server not RUNNING (status: ${this.serverManager.status})`)
    }

    const line = document.lineAt(position.line)
    const linePrefix = line.text.slice(0, position.character)

    // Mid-word bail: when the cursor splits an identifier, VS Code's own
    // word-based suggestions own that moment; a model completion starting
    // mid-word almost always restarts or mangles the word. At a word edge
    // (start/end) we still complete.
    const charBefore = position.character > 0 ? linePrefix[position.character - 1] : ''
    const charAfter = position.character < line.text.length ? line.text[position.character] : ''
    if (WORD_CHAR.test(charBefore) && WORD_CHAR.test(charAfter)) {
      return this.skip('cursor is mid-word (it splits an identifier)')
    }

    const prefixStart = Math.max(0, position.line - (PREFIX_LINES - 1))
    const prefix = document.getText(new Range(prefixStart, 0, position.line, position.character))
    if (!prefix.trim()) return this.skip('empty prefix (nothing before the cursor)')
    const suffixEnd = Math.min(document.lineCount - 1, position.line + SUFFIX_LINES)
    const suffix = document.getText(
      new Range(position.line, position.character, suffixEnd, document.lineAt(suffixEnd).text.length)
    )

    // Identical context as last time (e.g. the suggestion was just
    // dismissed and re-asked): answer from the cache instead of paying
    // for the same request again.
    const cacheKey = [
      document.uri.toString(), document.version, position.line, position.character, prefix.slice(-256)
    ].join(':')
    if (this.cache?.key === cacheKey) {
      return new InlineCompletionList([new InlineCompletionItem(this.cache.text, new Range(position, position))])
    }

    // Debounce: VS Code cancels the token as soon as the user types on, so
    // waking up cancelled means this call was superseded while waiting.
    if (!await this.settle(token)) return this.skip('superseded while debouncing (cancelled)')

    const model = await this.resolveModel(config)
    if (!model) return this.skip(this.noModelReason ?? 'no model resolved')
    if (token.isCancellationRequested) return this.skip('superseded before the request (cancelled)')

    // One request at a time: a newer call aborts the older one's HTTP.
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    let timedOut = false
    const hardTimeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    const cancellation = token.onCancellationRequested(() => controller.abort())
    try {
      const raw = await this.requestCompletion(
        model, this.buildMessages(document.languageId, prefix, suffix), controller.signal)
      if (token.isCancellationRequested) return this.skip('superseded during the request (cancelled)')
      const cleaned = cleanCompletion(raw, linePrefix, line.text)
      if (!cleaned) {
        return this.skip('response unusable (nothing left after cleanup)')
      }
      this.logSuccess(model, raw.length, cleaned.length)
      this.cache = { key: cacheKey, text: cleaned }
      return new InlineCompletionList([new InlineCompletionItem(cleaned, new Range(position, position))])
    } catch (err) {
      // chatCompletionOnce rejects on abort/timeout/HTTP errors; name which
      // one fired so the log distinguishes giving up from being superseded.
      if (timedOut) return this.skip(`request timed out after ${REQUEST_TIMEOUT_MS}ms`)
      if (token.isCancellationRequested) return this.skip('superseded during the request (cancelled)')
      if (controller.signal.aborted) return this.skip('request aborted (superseded by a newer request)')
      return this.skip(`request failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(hardTimeout)
      cancellation.dispose()
      if (this.inFlight === controller) this.inFlight = undefined
    }
  }

  /**
   * Which model serves completions, or undefined when none should.
   * Priority: `chanh.completions.model`, then the chat model setting —
   * but a candidate only counts when it is chat-capable AND already loaded
   * on the server (see the class comment: never load on a keystroke). With
   * nothing configured, the first loaded chat model wins. Cached briefly
   * because resolution costs two server round trips; `fresh` bypasses the
   * cache read (the self-test command uses it) and refreshes the cache.
   *
   * A fresh resolution records its outcome for the log: the picked model
   * (logged when it changes) or, when there is none, a one-line reason
   * carrying the configured candidates, the chat-capable count, and the
   * loaded list — provide() surfaces that reason through skip().
   */
  private async resolveModel(config: WorkspaceConfiguration, fresh = false): Promise<string | undefined> {
    const now = Date.now()
    if (!fresh && this.modelCache && now - this.modelCache.at < MODEL_CACHE_MS) return this.modelCache.model
    let model: string | undefined
    let reason: string | undefined
    try {
      const wanted = [
        config.get<string>('completions.model', ''),
        config.get<string>('chatModel', '')
      ].filter(Boolean)
      const models = await this.client.listModels()
      const chatModels = models.filter((m) => ModelManager.capabilityFor(m, 'chat'))
      const health = await this.client.getHealth().catch(() => undefined)
      const loaded = new Set(health?.all_models_loaded.map((m) => m.model_name) ?? [])
      model = wanted.find((id) => chatModels.some((m) => m.id === id) && loaded.has(id))
        ?? (wanted.length === 0 ? chatModels.find((m) => loaded.has(m.id))?.id : undefined)
      if (!model) {
        reason = 'no model resolved'
          + ` (configured: ${wanted.length ? wanted.join(', ') : 'none'};`
          + ` ${chatModels.length} chat-capable on server;`
          + ` loaded: ${[...loaded].join(', ') || 'none'})`
      }
    } catch (err) {
      reason = `model resolution failed: ${err instanceof Error ? err.message : String(err)}`
    }
    this.modelCache = { model, at: now }
    if (model) {
      if (this.lastResolvedModel !== model) {
        this.lastResolvedModel = model
        Logger.info(`Ghost text: model resolved to ${model}`)
      }
      this.noModelReason = undefined
    } else {
      this.lastResolvedModel = undefined
      this.noModelReason = reason
    }
    return model
  }

  /**
   * Record why this attempt produced no suggestion, and return the
   * undefined provide() should hand back. Each distinct reason is logged
   * ONCE — provide() runs on effectively every keystroke, so an unchanged
   * reason must stay silent; it logs again only after the reason changes
   * (or a success intervenes, see logSuccess).
   */
  private skip(reason: string): undefined {
    if (this.lastSkipReason !== reason) {
      this.lastSkipReason = reason
      Logger.info(`Ghost text: skipped — ${reason}`)
    }
    return undefined
  }

  /**
   * Log a served completion — lengths only, never the code itself. Logged
   * for the first success after any skip streak and whenever the serving
   * model changes; steady-state successes while typing stay unlogged, so
   * the channel shows state changes, not a per-keystroke transcript.
   */
  private logSuccess(model: string, rawLength: number, cleanedLength: number): void {
    if (this.lastSkipReason === undefined && this.lastSuccessModel === model) return
    this.lastSkipReason = undefined
    this.lastSuccessModel = model
    Logger.info(`Ghost text: completion from ${model} (raw ${rawLength} chars, cleaned ${cleanedLength} chars)`)
  }

  /** The exact prompt both provide() and the self-test send to the model. */
  private buildMessages(languageId: string, prefix: string, suffix: string): ChatMessage[] {
    return [
      {
        role: 'system',
        content: 'You are a code completion engine inside a text editor. Given the code before '
          + 'and after the cursor, output ONLY the code that belongs at the cursor. No '
          + 'explanations, no markdown, no code fences, and never repeat code that already '
          + 'appears before or after the cursor.'
      },
      {
        role: 'user',
        content: `Language: ${languageId}\n\n`
          + `<code_before_cursor>\n${prefix}\n</code_before_cursor>\n`
          + `<code_after_cursor>\n${suffix}\n</code_after_cursor>\n\n`
          + 'Output only the missing code at the cursor.'
      }
    ]
  }

  /** One bounded completion request; the single model-call code path. */
  private async requestCompletion(model: string, messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    return this.client.chatCompletionOnce(
      { model, messages, temperature: 0.2, max_tokens: MAX_COMPLETION_TOKENS },
      signal,
      REQUEST_TIMEOUT_MS
    )
  }

  /**
   * `Chanh: Test Ghost Text Completion` — walk the pipeline stage by stage
   * from the active editor's cursor, logging one line per stage to the
   * Chanh output channel and ending with a summary info message. Unlike
   * provide(), this is user-invoked, so the cleaned completion text itself
   * is logged (and the raw text too, when cleanup empties it — that is
   * exactly when its content explains the failure). Stops at the first
   * failing stage, mirroring provide()'s gate order, except the debounce
   * and the result cache, which a manual test has no use for. Never
   * throws: every failure becomes a log line plus an info message.
   */
  async testGhostText(): Promise<void> {
    const fail = (stage: string, reason: string): void => {
      Logger.info(`Ghost text test: FAILED at ${stage} — ${reason}`)
      void window.showInformationMessage(
        `Chanh ghost text test failed at ${stage}: ${reason} Details in the Chanh output channel.`)
    }
    try {
      Logger.info('Ghost text test: starting')
      const editor = window.activeTextEditor
      if (!editor) {
        Logger.info('Ghost text test: FAILED — no active editor')
        void window.showInformationMessage(
          'Chanh ghost text test: no active editor — open a file and place the cursor where you want a completion.')
        return
      }
      const document = editor.document
      const position = editor.selection.active
      Logger.info(
        `Ghost text test: editor "${document.fileName}" (${document.languageId}),`
        + ` cursor line ${position.line + 1}, char ${position.character + 1}`)

      const config = workspace.getConfiguration('chanh')
      const enabled = config.get<boolean>('completions.enabled', false)
      Logger.info(`Ghost text test: chanh.completions.enabled = ${enabled}`)
      if (!enabled) {
        return fail('setting', 'chanh.completions.enabled is off — inline completions never fire.')
      }
      if (document.uri.scheme === 'output') {
        return fail('document', 'documents with the "output" scheme are excluded.')
      }
      const status = this.serverManager.status
      Logger.info(`Ghost text test: server status = ${status}`)
      if (status !== ServerStatus.RUNNING) return fail('server', `server is not RUNNING (status: ${status}).`)

      const line = document.lineAt(position.line)
      const linePrefix = line.text.slice(0, position.character)
      const charBefore = position.character > 0 ? linePrefix[position.character - 1] : ''
      const charAfter = position.character < line.text.length ? line.text[position.character] : ''
      if (WORD_CHAR.test(charBefore) && WORD_CHAR.test(charAfter)) {
        return fail('cursor', 'cursor is mid-word (it splits an identifier) — ghost text skips here.')
      }

      const prefixStart = Math.max(0, position.line - (PREFIX_LINES - 1))
      const prefix = document.getText(new Range(prefixStart, 0, position.line, position.character))
      const suffixEnd = Math.min(document.lineCount - 1, position.line + SUFFIX_LINES)
      const suffix = document.getText(
        new Range(position.line, position.character, suffixEnd, document.lineAt(suffixEnd).text.length)
      )
      Logger.info(`Ghost text test: context prefix ${prefix.length} chars, suffix ${suffix.length} chars`)
      if (!prefix.trim()) return fail('context', 'empty prefix (nothing before the cursor).')

      const model = await this.resolveModel(config, true)
      if (!model) return fail('model', this.noModelReason ?? 'no model resolved.')
      Logger.info(`Ghost text test: model = ${model}`)

      const controller = new AbortController()
      let timedOut = false
      const hardTimeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, REQUEST_TIMEOUT_MS)
      const started = Date.now()
      let raw: string
      try {
        raw = await this.requestCompletion(
          model, this.buildMessages(document.languageId, prefix, suffix), controller.signal)
      } catch (err) {
        const elapsed = Date.now() - started
        if (timedOut) return fail('request', `timed out after ${REQUEST_TIMEOUT_MS}ms.`)
        return fail('request', `failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        clearTimeout(hardTimeout)
      }
      const elapsed = Date.now() - started
      const cleaned = cleanCompletion(raw, linePrefix, line.text)
      Logger.info(
        `Ghost text test: raw response ${raw.length} chars in ${elapsed}ms,`
        + ` cleaned ${cleaned?.length ?? 0} chars`)
      if (!cleaned) {
        Logger.info(`Ghost text test: raw response was:\n${raw}`)
        return fail('cleanup', 'the response was empty or unusable after cleanup — raw text logged above.')
      }
      Logger.info(`Ghost text test: cleaned completion:\n${cleaned}`)
      const preview = cleaned.replace(/\s+/g, ' ').trim()
      const shown = preview.length > 60 ? `${preview.slice(0, 60)}…` : preview
      Logger.info('Ghost text test: OK')
      void window.showInformationMessage(`Chanh ghost text works — ${model} suggested: "${shown}"`)
    } catch (err) {
      Logger.error('Ghost text test: unexpected error', err)
      void window.showInformationMessage(
        'Chanh ghost text test hit an unexpected error — see the Chanh output channel.')
    }
  }

  /** Resolve true after the debounce delay, false when cancelled first. */
  private settle(token: CancellationToken): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cancellation.dispose()
        resolve(!token.isCancellationRequested)
      }, DEBOUNCE_MS)
      const cancellation = token.onCancellationRequested(() => {
        clearTimeout(timer)
        resolve(false)
      })
    })
  }

  dispose(): void {
    this.inFlight?.abort()
    while (this.subscriptions.length > 0) this.subscriptions.pop()?.dispose()
  }
}
