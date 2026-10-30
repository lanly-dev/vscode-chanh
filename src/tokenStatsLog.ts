import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import type { ChatStreamStats } from './interfaces'
import { Logger } from './logger'

/**
 * Persistent per-turn token usage log — the "Token stats logs" follow-up to
 * the chat footer (`chanh.showTokenStats`). The footer shows one turn's
 * numbers and forgets them; this module appends every turn whose server
 * `usage` block was complete to a JSONL file in the extension's
 * globalStorage, so `Chanh: Show Token Usage` can total them up later.
 *
 * Only server-reported usage is recorded: when the backend sends no `usage`
 * block the footer falls back to a character estimate, and an estimate in
 * the log would silently corrupt the totals.
 */

/** Where a recorded turn ran: the `@chanh` participant or the native picker. */
export type TokenUsageSource = 'chat' | 'agent'

/** One completed turn's server-reported token usage, as stored in the log. */
export interface TokenUsageRecord {
  /** ISO-8601 timestamp of when the turn completed. */
  ts: string
  model: string
  source: TokenUsageSource
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Aggregated usage for a single model within a period. */
export interface ModelUsageTotals {
  model: string
  turns: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Aggregated usage over one period (today, or all time). */
export interface TokenUsagePeriod {
  turns: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Per-model breakdown, busiest model first. */
  perModel: ModelUsageTotals[]
}

/** The summary rendered by `Chanh: Show Token Usage`. */
export interface TokenUsageSummary {
  today: TokenUsagePeriod
  allTime: TokenUsagePeriod
}

const LOG_FILE_NAME = 'token-usage.jsonl'

let logFilePath: string | undefined

/** Point the log at this extension's globalStorage. Called once on activation. */
export function initTokenStatsLog(context: vscode.ExtensionContext): void {
  logFilePath = path.join(context.globalStorageUri.fsPath, LOG_FILE_NAME)
}

/**
 * Append one completed turn to the log. No-ops when the log was never
 * initialized or the server did not report a complete `usage` block, and
 * never throws — a failed write must not break the chat turn it rode on.
 */
export function recordTokenUsage(model: string, source: TokenUsageSource, stats: ChatStreamStats): void {
  if (!logFilePath || !model) return
  const { promptTokens, completionTokens, totalTokens } = stats
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) return
  const record: TokenUsageRecord = {
    ts: new Date().toISOString(),
    model,
    source,
    promptTokens,
    completionTokens,
    totalTokens
  }
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
    const fd = fs.openSync(logFilePath, 'a+')
    try {
      const size = fs.fstatSync(fd).size
      let separator = ''
      if (size > 0) {
        const lastByte = Buffer.alloc(1)
        fs.readSync(fd, lastByte, 0, 1, size - 1)
        if (lastByte[0] !== 0x0a) separator = '\n'
      }
      fs.appendFileSync(fd, `${separator}${JSON.stringify(record)}\n`, 'utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    Logger.error('Failed to record token usage', err)
  }
}

/** Shape check for one parsed log line; anything else is skipped. */
function isTokenUsageRecord(value: unknown): value is TokenUsageRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return typeof r.ts === 'string' && !Number.isNaN(Date.parse(r.ts)) &&
    typeof r.model === 'string' && r.model.length > 0 &&
    (r.source === 'chat' || r.source === 'agent') &&
    [r.promptTokens, r.completionTokens, r.totalTokens]
      .every((n) => typeof n === 'number' && Number.isFinite(n))
}

/**
 * Parse JSONL log text into records. Corrupt or partial lines — a torn
 * final write after a crash is the expected case — are skipped, never fatal.
 */
export function parseTokenUsageLog(text: string): TokenUsageRecord[] {
  const records: TokenUsageRecord[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isTokenUsageRecord(parsed)) records.push(parsed)
    } catch {
      // Skip the bad line and keep the rest of the log usable.
    }
  }
  return records
}

function emptyPeriod(): TokenUsagePeriod {
  return { turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, perModel: [] }
}

function accumulate(period: TokenUsagePeriod, byModel: Map<string, ModelUsageTotals>, record: TokenUsageRecord): void {
  period.turns++
  period.promptTokens += record.promptTokens
  period.completionTokens += record.completionTokens
  period.totalTokens += record.totalTokens
  let totals = byModel.get(record.model)
  if (!totals) {
    totals = { model: record.model, turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    byModel.set(record.model, totals)
  }
  totals.turns++
  totals.promptTokens += record.promptTokens
  totals.completionTokens += record.completionTokens
  totals.totalTokens += record.totalTokens
}

/**
 * Total the records into today (the local calendar day of `now`) and
 * all-time periods, each with a per-model breakdown.
 */
export function summarizeTokenUsage(records: TokenUsageRecord[], now: Date): TokenUsageSummary {
  const today = emptyPeriod()
  const allTime = emptyPeriod()
  const todayModels = new Map<string, ModelUsageTotals>()
  const allModels = new Map<string, ModelUsageTotals>()
  for (const record of records) {
    accumulate(allTime, allModels, record)
    const ts = new Date(record.ts)
    if (ts.getFullYear() === now.getFullYear() && ts.getMonth() === now.getMonth() &&
      ts.getDate() === now.getDate()) {
      accumulate(today, todayModels, record)
    }
  }
  const finish = (period: TokenUsagePeriod, byModel: Map<string, ModelUsageTotals>): TokenUsagePeriod => {
    period.perModel = [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens)
    return period
  }
  return { today: finish(today, todayModels), allTime: finish(allTime, allModels) }
}

/** Read and parse the whole log; a missing or unreadable file reads as empty. */
export function loadTokenUsageRecords(): TokenUsageRecord[] {
  if (!logFilePath) return []
  try {
    return parseTokenUsageLog(fs.readFileSync(logFilePath, 'utf8'))
  } catch {
    return []
  }
}

/**
 * `Chanh: Show Token Usage` — render the log's today / all-time totals in a
 * read-only panel, following the Model Info panel's presentation.
 */
export async function showTokenUsage(): Promise<void> {
  const summary = summarizeTokenUsage(loadTokenUsageRecords(), new Date())
  const panel = vscode.window.createWebviewPanel(
    'chanhTokenUsage', 'Token Usage', vscode.ViewColumn.Active, { enableScripts: false }
  )
  panel.webview.html = buildTokenUsageHtml(summary, logFilePath)
}

/** Render the usage summary as a self-contained HTML page (Model Info style). */
export function buildTokenUsageHtml(summary: TokenUsageSummary, logPath?: string): string {
  const esc = (value: unknown): string => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const num = (n: number): string => n.toLocaleString()

  const periodTable = (period: TokenUsagePeriod): string => {
    if (period.turns === 0) return '<div class="sub">No turns recorded.</div>'
    const rows = period.perModel.map((m) =>
      `<tr><td>${esc(m.model)}</td><td>${num(m.turns)}</td>` +
      `<td>${num(m.promptTokens)}</td><td>${num(m.completionTokens)}</td><td>${num(m.totalTokens)}</td></tr>`
    ).join('\n      ')
    return `<table>
      <tr><th>Model</th><th>Turns</th><th>In</th><th>Out</th><th>Total</th></tr>
      ${rows}
      <tr class="total"><td>All models</td><td>${num(period.turns)}</td>` +
      `<td>${num(period.promptTokens)}</td><td>${num(period.completionTokens)}</td>` +
      `<td>${num(period.totalTokens)}</td></tr>
    </table>`
  }

  const body = summary.allTime.turns === 0
    ? '<div class="sub">No token usage recorded yet. Completed chat and agent turns are logged ' +
      'whenever the server reports a usage block for the turn.</div>'
    : `<h3>Today</h3>
  ${periodTable(summary.today)}
  <h3>All time</h3>
  ${periodTable(summary.allTime)}`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 12px 16px; font-size: var(--vscode-font-size); }
  h2 { margin: 0 0 4px; font-weight: 600; }
  h3 { margin: 18px 0 4px; font-weight: 600; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: right; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  th:first-child, td:first-child { text-align: left; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  tr.total td { font-weight: 600; }
</style>
</head>
<body>
  <h2>Token Usage</h2>
  <div class="sub">Server-reported tokens per completed turn, logged locally` +
    `${logPath ? ` in <code>${esc(logPath)}</code>` : ''}. ` +
    `Turns the server reported no usage for are not counted.</div>
  ${body}
</body>
</html>`
}
