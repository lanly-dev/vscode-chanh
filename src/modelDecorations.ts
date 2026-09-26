import * as vscode from 'vscode'

/**
 * Colors installed-model and backend rows in the Servers tree.
 *
 * The tree-item API cannot color label text directly, so loaded models get
 * their green label through the FileDecoration API: each row carries a
 * `chanh-model:` (or `chanh-backend:`) resource URI encoding its state, and
 * this provider tints matching labels green.
 */
export class ModelDecorationProvider implements vscode.FileDecorationProvider {
  /** Build the resource URI for a model row. */
  static uriFor(modelId: string, isLoaded: boolean): vscode.Uri {
    return vscode.Uri.from({
      scheme: 'chanh-model',
      path: `/${modelId}`,
      query: `loaded=${isLoaded ? '1' : '0'}`
    })
  }

  /** Build the resource URI for a backend row. */
  static uriForBackend(recipe: string, backend: string, isRunning: boolean): vscode.Uri {
    return vscode.Uri.from({
      scheme: 'chanh-backend',
      path: `/${recipe}/${backend}`,
      query: `running=${isRunning ? '1' : '0'}`
    })
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === 'chanh-backend') {
      if (uri.query.includes('running=1')) {
        return {
          color: new vscode.ThemeColor('charts.green'),
          tooltip: 'In use by a loaded model'
        }
      }
      return { tooltip: 'Not in use' }
    }
    if (uri.scheme !== 'chanh-model') return undefined
    if (uri.query.includes('loaded=1')) {
      return {
        color: new vscode.ThemeColor('charts.green'),
        tooltip: 'Loaded'
      }
    }
    return { tooltip: 'Not loaded' }
  }
}
