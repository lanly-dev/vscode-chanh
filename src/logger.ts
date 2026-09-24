import * as vscode from 'vscode'

/** Centralized logger that writes to a VS Code output channel */
export class Logger {
  private static channel: vscode.OutputChannel | undefined

  static init(): void {
    if (Logger.channel) return
    Logger.channel = vscode.window.createOutputChannel('Chanh')
  }

  static info(message: string): void {
    Logger.init()
    const timestamp = new Date().toISOString()
    Logger.channel!.appendLine(`[INFO  ${timestamp}] ${message}`)
  }

  static warn(message: string): void {
    Logger.init()
    const timestamp = new Date().toISOString()
    Logger.channel!.appendLine(`[WARN  ${timestamp}] ${message}`)
  }

  static error(message: string, error?: unknown): void {
    Logger.init()
    const timestamp = new Date().toISOString()
    if (error instanceof Error) {
      Logger.channel!.appendLine(`[ERROR ${timestamp}] ${message}: ${error.message}`)
      if (error.stack) Logger.channel!.appendLine(error.stack)
    } else Logger.channel!.appendLine(`[ERROR ${timestamp}] ${message}`)
  }

  static show(): void {
    Logger.init()
    Logger.channel!.show()
  }

  /** Dispose the output channel on extension deactivation. */
  static dispose(): void {
    Logger.channel?.dispose()
    Logger.channel = undefined
  }

  /** Adapter so the static logger can ride `context.subscriptions` like other disposables. */
  static toDisposable(): vscode.Disposable {
    return new vscode.Disposable(() => Logger.dispose())
  }
}
