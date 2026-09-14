import * as vscode from 'vscode'
import { ServerInstance, ServerStatus } from './interfaces'

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

export function openSetting(): void {
  vscode.commands.executeCommand('workbench.action.openSettings', '@ext:lanly-dev.chanh')
}

export function openUrl(item: vscode.TreeItem): void {
  const label = item?.label
  if (!label) return
  const url = typeof label === 'string' ? label : label.label
  if (!url) return
  vscode.env.openExternal(vscode.Uri.parse(url))
}
