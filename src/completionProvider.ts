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
 */
export class GhostTextProvider implements InlineCompletionItemProvider, Disposable {
  private client: LemonadeClient
  private readonly subscriptions: Disposable[] = []
  private inFlight: AbortController | undefined
  private cache: { key: string, text: string } | undefined
  private modelCache: { model: string | undefined, at: number } | undefined

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
    if (!config.get<boolean>('completions.enabled', false)) return undefined
    if (document.uri.scheme === 'output') return undefined
    if (this.serverManager.status !== ServerStatus.RUNNING) return undefined

    const line = document.lineAt(position.line)
    const linePrefix = line.text.slice(0, position.character)

    // Mid-word bail: when the cursor splits an identifier, VS Code's own
    // word-based suggestions own that moment; a model completion starting
    // mid-word almost always restarts or mangles the word. At a word edge
    // (start/end) we still complete.
    const charBefore = position.character > 0 ? linePrefix[position.character - 1] : ''
    const charAfter = position.character < line.text.length ? line.text[position.character] : ''
    if (WORD_CHAR.test(charBefore) && WORD_CHAR.test(charAfter)) return undefined

    const prefixStart = Math.max(0, position.line - (PREFIX_LINES - 1))
    const prefix = document.getText(new Range(prefixStart, 0, position.line, position.character))
    if (!prefix.trim()) return undefined
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
    if (!await this.settle(token)) return undefined

    const model = await this.resolveModel(config)
    if (!model || token.isCancellationRequested) return undefined

    // One request at a time: a newer call aborts the older one's HTTP.
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    const hardTimeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const cancellation = token.onCancellationRequested(() => controller.abort())
    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a code completion engine inside a text editor. Given the code before '
            + 'and after the cursor, output ONLY the code that belongs at the cursor. No '
            + 'explanations, no markdown, no code fences, and never repeat code that already '
            + 'appears before or after the cursor.'
        },
        {
          role: 'user',
          content: `Language: ${document.languageId}\n\n`
            + `<code_before_cursor>\n${prefix}\n</code_before_cursor>\n`
            + `<code_after_cursor>\n${suffix}\n</code_after_cursor>\n\n`
            + 'Output only the missing code at the cursor.'
        }
      ]
      const raw = await this.client.chatCompletionOnce(
        { model, messages, temperature: 0.2, max_tokens: MAX_COMPLETION_TOKENS },
        controller.signal,
        REQUEST_TIMEOUT_MS
      )
      if (token.isCancellationRequested) return undefined
      const cleaned = cleanCompletion(raw, linePrefix, line.text)
      if (!cleaned) return undefined
      this.cache = { key: cacheKey, text: cleaned }
      return new InlineCompletionList([new InlineCompletionItem(cleaned, new Range(position, position))])
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
   * because resolution costs two server round trips.
   */
  private async resolveModel(config: WorkspaceConfiguration): Promise<string | undefined> {
    const now = Date.now()
    if (this.modelCache && now - this.modelCache.at < MODEL_CACHE_MS) return this.modelCache.model
    let model: string | undefined
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
    } catch {
      model = undefined
    }
    this.modelCache = { model, at: now }
    return model
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
