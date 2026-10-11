import * as vscode from 'vscode'
import { Logger } from './logger'
import { ServerInstance, ServerStatus, ChatStreamStats } from './interfaces'

export function getServerStatusChar(status: ServerInstance['status']): { color: string, icon: string, text: string } {
  switch (status) {
    case ServerStatus.RUNNING:
      return { color: 'charts.green', icon: 'debug-start', text: 'Running' }
    case ServerStatus.STARTING:
      return { color: 'charts.yellow', icon: 'loading~spin', text: 'Starting...' }
    case ServerStatus.STOPPED:
      return { color: 'charts.gray', icon: 'debug-stop', text: 'Stopped' }
    case ServerStatus.ERROR:
      return { color: 'charts.red', icon: 'error', text: 'Error' }
    default:
      return { color: 'charts.gray', icon: 'question', text: 'Unknown' }
  }
}

export function getCapIcon(uri: vscode.Uri, category: string): vscode.ThemeIcon | vscode.Uri {
  if (category === 'other') return new vscode.ThemeIcon('circle-filled')
  return vscode.Uri.joinPath(uri, 'media', 'capabilities', `${category}.svg`)
}


/**
 * Render the per-turn token stats footer from a streamed response. `stats` comes
 * from the server's `usage` block; when the backend didn't report tokens, output
 * tokens are estimated from the rendered text length (`chars / 4`) so the footer
 * still shows something instead of blanking out.
 *
 * @param outputChars Assistant's full reply length; used only to fill the "out"
 *  side when the server provided no usage.
 */
export function formatTurnFooter(stats: ChatStreamStats, outputChars = 0): string | undefined {
  const hasServerUsage = stats.promptTokens !== undefined &&
    stats.completionTokens !== undefined && stats.totalTokens !== undefined

  if (!hasServerUsage && outputChars > 0) {
    const output = Math.max(stats.completionTokens ?? 0, Math.ceil(outputChars / 4))
    return `*Tokens: ↓~${output} out (est)*`
  }

  const parts: string[] = []
  if (stats.promptTokens !== undefined) parts.push(`↑${stats.promptTokens} in`)
  if (stats.completionTokens !== undefined) parts.push(`↓${stats.completionTokens} out`)
  if (stats.totalTokens !== undefined) parts.push(`${stats.totalTokens} total`)
  return `*Tokens: ${parts.join(' · ')}*`
}

/** Close a fenced code block left open by streamed model output, if present. */
export function closeOpenMarkdownFence(markdown: string): string {
  let openFence: { marker: string, length: number } | undefined

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!match) continue

    const marker = match[1][0]
    const length = match[1].length
    const rest = match[2]
    if (!openFence) {
      if (marker !== '`' || !rest.includes('`')) openFence = { marker, length }
    } else if (marker === openFence.marker && length >= openFence.length && /^\s*$/.test(rest)) {
      openFence = undefined
    }
  }

  return openFence ? `\n${openFence.marker.repeat(openFence.length)}\n` : ''
}

/**
 * Whether the per-turn token-stats footer is enabled. Controlled by
 * `chanh.showTokenStats`, default `false`.
 */
export function shouldShowTokenStats(): boolean {
  return vscode.workspace.getConfiguration('chanh').get<boolean>('showTokenStats', false)
}


/** Format a byte count as a human-readable size (e.g. 1.2 GB). */
export function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = value
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit++
  }
  return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** Format a model size given in GB as a human-readable string (e.g. "4.00 GB" or "2.0 TB"). */
export function formatSize(sizeGb: number | undefined): string {
  if (!sizeGb || sizeGb <= 0) return ''
  return sizeGb >= 1024 ? `${(sizeGb / 1024).toFixed(1)} TB` : `${sizeGb.toFixed(2)} GB`
}

/**
 * Format an in-progress download as "written / total" in a single unit, with
 * enough decimals that the text keeps advancing during the transfer. Showing a
 * plain `formatBytes` pair steps in coarse ~100 MB jumps for a multi-GB model,
 * which makes the row look frozen between updates.
 */
export function formatByteProgress(written: number, total: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unit = 0
  let divisor = 1
  // Pick the unit from the total so both numbers are shown at the same scale.
  while (total / divisor >= 1024 && unit < units.length - 1) {
    divisor *= 1024
    unit++
  }
  // Bytes/KB need no decimals; MB and above use two so the value advances in
  // fine increments (for GB that is ~10 MB per step) instead of 100 MB ones.
  const digits = unit <= 1 ? 0 : 2
  return `${(written / divisor).toFixed(digits)} / ${(total / divisor).toFixed(digits)} ${units[unit]}`
}

export function openSetting(): void {
  vscode.commands.executeCommand('workbench.action.openSettings', '@ext:lanly-dev.chanh')
}

export function openUrl(item: vscode.TreeItem): void {
  const label = item?.label
  if (!label) return
  const url = typeof label === 'string' ? label : label.label
  if (!url) return

  let parsed: vscode.Uri
  try {
    parsed = vscode.Uri.parse(url)
  } catch {
    vscode.window.showErrorMessage(`Cannot open server URL: invalid address (${url})`)
    Logger.error(`openUrl: cannot parse label as URI: ${url}`)
    return
  }

  // Only allow http/https URIs — no file://, no javascript: etc.
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
    vscode.window.showErrorMessage(`Cannot open server URL: unsupported scheme (${parsed.scheme})`)
    Logger.error(`openUrl: rejecting non-web URI scheme "${parsed.scheme}"`)
    return
  }

  vscode.env.openExternal(parsed)
}

export function revealBinaryDir(binaryDir: string): void {
  const uri = vscode.Uri.file(binaryDir)
  vscode.commands.executeCommand('revealFileInOS', uri)
}
