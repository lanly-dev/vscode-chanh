import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'
import {
  Position,
  ProgressLocation,
  Range,
  Selection,
  TextEditorRevealType,
  Uri,
  window,
  workspace
} from 'vscode'

import type { ChatParticipant } from './chatParticipant'
import { ServerStatus } from './interfaces'
import { Logger } from './logger'
import type { ServerManager } from './serverManager'
import {
  applyReadmeSection,
  buildDraftMessages,
  extractBullets,
  findVersionBump,
  formatDate,
  insertChangelogSection,
  type PackageCommit
} from './releaseNotesCore'

const execFileAsync = promisify(execFile)

/** How many package.json-touching commits to walk when hunting the version bump. */
const MAX_PACKAGE_COMMITS = 80

/** Commit range used when no version bump exists in the walked history. */
const FALLBACK_COMMIT_COUNT = 50

/** Run git in the workspace root; any failure becomes a thrown Error. */
async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30000
    })
    return String(stdout)
  } catch (err) {
    throw new Error(`git ${args[0]} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The version string a historical commit left in package.json, if readable. */
async function versionAtCommit(cwd: string, hash: string): Promise<string | undefined> {
  try {
    const raw = await runGit(cwd, ['show', `${hash}:package.json`])
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/** Newest-first commits that touched package.json, with the version each set. */
async function packageCommits(cwd: string): Promise<PackageCommit[]> {
  const log = await runGit(cwd, ['log', '--format=%H', `-n`, String(MAX_PACKAGE_COMMITS), '--', 'package.json'])
  const commits: PackageCommit[] = []
  for (const hash of log.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const version = await versionAtCommit(cwd, hash)
    if (version) commits.push({ hash, version })
  }
  return commits
}

/** Compact "most-changed files" summary for the prompt, most active first. */
function summarizeFiles(nameOnlyOutput: string): string[] {
  const counts = new Map<string, number>()
  for (const line of nameOnlyOutput.split('\n')) {
    const file = line.trim()
    if (file) counts.set(file, (counts.get(file) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const shown = sorted.slice(0, 15).map(([file, n]) => `- ${file} (${n} commit${n === 1 ? '' : 's'})`)
  if (sorted.length > 15) shown.push(`- (and ${sorted.length - 15} more files)`)
  return shown
}

/**
 * "Chanh: Draft Release Notes" — draft the current version's changelog entry
 * from git history with the selected chat model, then apply the SAME bullets
 * to CHANGELOG.md and README.md so the two copies cannot drift apart. When
 * either file already has content for the current version nothing is
 * overwritten: the draft opens as an untitled document instead.
 */
export async function draftReleaseNotes(
  serverManager: ServerManager,
  chatParticipant: ChatParticipant
): Promise<void> {
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!root) {
    window.showErrorMessage('Draft Release Notes needs a workspace folder open.')
    return
  }
  const packagePath = path.join(root, 'package.json')
  const changelogPath = path.join(root, 'CHANGELOG.md')
  const readmePath = path.join(root, 'README.md')
  for (const file of [packagePath, changelogPath, readmePath]) {
    if (!fs.existsSync(file)) {
      window.showErrorMessage(`Draft Release Notes needs ${path.basename(file)} in the workspace root.`)
      return
    }
  }

  let version: string
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown }
    if (typeof parsed.version !== 'string' || !parsed.version) throw new Error('no version field')
    version = parsed.version
  } catch {
    window.showErrorMessage('Could not read a version from package.json.')
    return
  }

  // All git work happens before any file write, so a git failure can never
  // leave the docs half-updated.
  let subjects: string[]
  let fileSummary: string[]
  let usedFallback = false
  try {
    await runGit(root, ['rev-parse', '--is-inside-work-tree'])
    const bump = findVersionBump(await packageCommits(root))
    const rangeArgs = bump ? [`${bump}..HEAD`] : ['-n', String(FALLBACK_COMMIT_COUNT)]
    usedFallback = !bump
    const logOutput = await runGit(root, ['log', '--format=%s', ...rangeArgs])
    subjects = logOutput.split('\n').map((l) => l.trim()).filter(Boolean)
    const nameOnly = await runGit(root, ['log', '--format=', '--name-only', ...rangeArgs])
    fileSummary = summarizeFiles(nameOnly)
  } catch (err) {
    Logger.error('Draft Release Notes: git history unavailable', err)
    window.showErrorMessage(
      'Could not read the git history (git unavailable or not a repository). No files were changed.'
    )
    return
  }
  if (subjects.length === 0) {
    window.showInformationMessage(
      `No commits since version ${version} was set — nothing to draft.`
    )
    return
  }

  // The model call reuses the chat participant's server flow, including its
  // offer to start a stopped server.
  if (serverManager.status !== ServerStatus.RUNNING) {
    const start = await window.showInformationMessage(
      'Lemonade Server is not running. Start it now?',
      'Start Server',
      'Cancel'
    )
    if (start !== 'Start Server') return
    if (!await serverManager.start()) {
      window.showErrorMessage('Failed to start Lemonade Server. Please check the output for details.')
      return
    }
  }

  const date = formatDate(new Date())
  let bullets: string[]
  try {
    const { system, user } = buildDraftMessages(version, subjects, fileSummary)
    const text = await window.withProgress(
      { location: ProgressLocation.Notification, title: `Drafting release notes for ${version}…` },
      () => chatParticipant.completeWithChatModel([
        { role: 'system', content: system },
        { role: 'user', content: user }
      ])
    )
    bullets = extractBullets(text)
  } catch (err) {
    Logger.error('Draft Release Notes: model call failed', err)
    window.showErrorMessage(
      `Failed to draft release notes: ${err instanceof Error ? err.message : String(err)}`
    )
    return
  }
  if (bullets.length === 0) {
    window.showErrorMessage('The model returned no usable release-note bullets. No files were changed.')
    return
  }

  const fallbackNote = usedFallback
    ? `Drafted from the last ${FALLBACK_COMMIT_COUNT} commits — ` +
      'no package.json version bump was found in the walked history.'
    : undefined
  const changelog = insertChangelogSection(
    fs.readFileSync(changelogPath, 'utf8'), version, date, bullets, fallbackNote
  )
  const readme = applyReadmeSection(fs.readFileSync(readmePath, 'utf8'), version, bullets)

  if (changelog.outcome === 'exists' || readme.outcome === 'exists') {
    const blockers = [
      changelog.outcome === 'exists' ? 'CHANGELOG.md' : undefined,
      readme.outcome === 'exists' ? 'README.md' : undefined
    ].filter(Boolean).join(' and ')
    const draft = [
      ...(fallbackNote ? [`<!-- ${fallbackNote} -->`] : []),
      `## [${version}] - ${date}`,
      ...bullets,
      ''
    ].join('\n')
    const doc = await workspace.openTextDocument({ language: 'markdown', content: draft })
    await window.showTextDocument(doc)
    window.showWarningMessage(
      `${blockers} already ${blockers.includes(' and ') ? 'have' : 'has'} a ${version} section, ` +
      'so the draft was opened as an untitled document instead of overwriting it.'
    )
    return
  }

  fs.writeFileSync(changelogPath, changelog.content, 'utf8')
  fs.writeFileSync(readmePath, readme.content, 'utf8')
  Logger.info(`Drafted ${version} release notes (${bullets.length} bullets) in CHANGELOG.md and README.md`)

  const doc = await workspace.openTextDocument(Uri.file(changelogPath))
  const editor = await window.showTextDocument(doc)
  const headerLine = changelog.content.split('\n').findIndex((l) => l.startsWith(`## [${version}]`))
  if (headerLine >= 0) {
    const pos = new Position(headerLine, 0)
    editor.selection = new Selection(pos, pos)
    editor.revealRange(new Range(pos, pos), TextEditorRevealType.AtTop)
  }
  window.showInformationMessage(
    `Drafted the ${version} release notes in CHANGELOG.md and README.md — review before committing.`
  )
}
