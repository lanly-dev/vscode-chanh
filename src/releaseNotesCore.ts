/**
 * Pure helpers for the "Draft Release Notes" command: version-range maths,
 * model-output cleanup, and the markdown surgery that keeps CHANGELOG.md and
 * README.md carrying the same bullets. Nothing here imports `vscode` or does
 * IO, so the plain-node test in test/releaseNotes.test.cjs can exercise it by
 * transpiling this file with the project's own TypeScript compiler.
 */

/** A commit that touched package.json, newest first, with the version it left behind. */
export interface PackageCommit {
  hash: string
  version: string
}

/**
 * Find the newest commit that CHANGED the package.json version: the first
 * entry (walking newest to oldest) whose version differs from the next older
 * entry's. Returns undefined when the version never changed in the walked
 * history (single-entry or all-equal lists included) so the caller can fall
 * back to a plain commit count.
 */
export function findVersionBump(commits: PackageCommit[]): string | undefined {
  for (let i = 0; i + 1 < commits.length; i++) {
    if (commits[i].version !== commits[i + 1].version) return commits[i].hash
  }
  return undefined
}

/** Format a date the way the changelog headers do: YYYY-MM-DD, local time. */
export function formatDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Reduce raw model output to a clean bullet list: drop code-fence lines,
 * keep only list-looking lines (`-`, `*`, `+`, `•`, or `1.` styles), and
 * normalize them to the `- ` form the changelog uses. Headings, prose, and
 * blank lines are discarded; duplicates collapse; the list is capped so a
 * rambling model cannot flood the changelog.
 */
export function extractBullets(text: string): string[] {
  const bullets: string[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('```')) continue
    const match = /^[-*+•]\s+(.+)$/.exec(line) ?? /^\d{1,2}[.)]\s+(.+)$/.exec(line)
    if (!match) continue
    const bullet = `- ${match[1].trim()}`
    const key = bullet.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    bullets.push(bullet)
    if (bullets.length >= 12) break
  }
  return bullets
}

/**
 * The messages sent to the chat model. The system prompt pins the house
 * style visible in CHANGELOG.md's recent sections: terse imperative bullets,
 * user-facing changes only, no hashes, no VSIX listing.
 */
export function buildDraftMessages(
  version: string,
  subjects: string[],
  fileSummary: string[]
): { system: string, user: string } {
  const system = 'You draft release notes for the Chanh VS Code extension. '
    + 'Output ONLY a bullet list — no heading, no code fence, no intro or closing text. '
    + 'One bullet per user-facing change, each starting with "- ", short and imperative, '
    + 'matching this style: "- Add Copy ID context menu options", "- Improve chat `@chanh`", '
    + '"- New Get Started walkthrough". Group related commits into a single bullet. '
    + 'Skip version bumps, merge commits, and pure chore/doc commits unless nothing else remains. '
    + 'Never include commit hashes or a package file listing. At most 8 bullets.'
  const shown = subjects.slice(0, 100)
  const more = subjects.length - shown.length
  const user = [
    `Draft the release notes for version ${version}.`,
    '',
    'Commits in this release:',
    ...shown.map((s) => `- ${s}`),
    ...(more > 0 ? [`- (and ${more} more commits)`] : []),
    '',
    'Most-changed files:',
    ...fileSummary
  ].join('\n')
  return { system, user }
}

/** What happened when a section was applied to a file. */
export type SectionOutcome = 'inserted' | 'filled' | 'exists'

export interface SectionResult {
  content: string
  outcome: SectionOutcome
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Index of the first heading line at or after `from` matching `pattern`, or -1. */
function findHeading(lines: string[], pattern: RegExp, from = 0): number {
  for (let i = from; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i
  }
  return -1
}

/** End index (exclusive) of the section starting at `headingIdx`. */
function sectionEnd(lines: string[], headingIdx: number, boundary: RegExp): number {
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (boundary.test(lines[i])) return i
  }
  return lines.length
}

/** A section counts as having content when any body line is non-blank. */
function sectionHasContent(lines: string[], headingIdx: number, end: number): boolean {
  for (let i = headingIdx + 1; i < end; i++) {
    if (lines[i].trim()) return true
  }
  return false
}

/**
 * Apply bullets to CHANGELOG.md for `version`. A missing section is inserted
 * directly below the `## [TODO]` block (or above the first version section
 * when there is no TODO block); an existing-but-empty section is filled in
 * place; an existing section with any content is left untouched and reported
 * as 'exists' so the caller can refuse to overwrite it. `fallbackNote`, when
 * given, is recorded as an HTML comment above the new section.
 */
export function insertChangelogSection(
  content: string,
  version: string,
  date: string,
  bullets: string[],
  fallbackNote?: string
): SectionResult {
  const lines = content.split('\n')
  const boundary = /^##\s/
  const headingRe = new RegExp(`^## \\[${escapeRegExp(version)}\\](\\s|$)`)
  const existing = findHeading(lines, headingRe)
  if (existing >= 0) {
    const end = sectionEnd(lines, existing, boundary)
    if (sectionHasContent(lines, existing, end)) return { content, outcome: 'exists' }
    const fill = [...bullets]
    if (end < lines.length) fill.push('')
    lines.splice(existing + 1, end - existing - 1, ...fill)
    return { content: lines.join('\n'), outcome: 'filled' }
  }

  const block: string[] = []
  if (fallbackNote) block.push(`<!-- ${fallbackNote} -->`)
  block.push(`## [${version}] - ${date}`, ...bullets, '')

  // Insertion point: the first version section after the TODO block, else
  // the first version section anywhere, else end of file.
  const todoIdx = findHeading(lines, /^## \[TODO\]/)
  let insertAt = todoIdx >= 0 ? findHeading(lines, /^## \[/, todoIdx + 1) : -1
  if (insertAt < 0 && todoIdx < 0) insertAt = findHeading(lines, /^## \[/)
  if (insertAt < 0) {
    const tail = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    return { content: [...tail, '', ...block].join('\n'), outcome: 'inserted' }
  }
  if (insertAt > 0 && lines[insertAt - 1].trim()) block.unshift('')
  lines.splice(insertAt, 0, ...block)
  return { content: lines.join('\n'), outcome: 'inserted' }
}

/**
 * Apply the same bullets to README.md's `### <version>` heading under
 * `## Release Notes`. Same contract as the changelog: create the heading in
 * the newest-first position when missing, fill an empty one, never overwrite
 * one that already has content.
 */
export function applyReadmeSection(
  content: string,
  version: string,
  bullets: string[]
): SectionResult {
  const lines = content.split('\n')
  const boundary = /^#{2,3}\s/
  const headingRe = new RegExp(`^### ${escapeRegExp(version)}(\\s|$)`)
  const existing = findHeading(lines, headingRe)
  if (existing >= 0) {
    const end = sectionEnd(lines, existing, boundary)
    if (sectionHasContent(lines, existing, end)) return { content, outcome: 'exists' }
    const fill = [...bullets]
    if (end < lines.length) fill.push('')
    lines.splice(existing + 1, end - existing - 1, ...fill)
    return { content: lines.join('\n'), outcome: 'filled' }
  }

  const block = [`### ${version}`, ...bullets, '']
  const releaseIdx = findHeading(lines, /^## Release Notes\s*$/)
  if (releaseIdx < 0) {
    const tail = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    return { content: [...tail, '', '## Release Notes', '', ...block].join('\n'), outcome: 'inserted' }
  }
  // Newest version goes first: directly above the first existing `### `
  // heading under Release Notes, or right after the heading when none exist.
  const firstVersion = findHeading(lines, /^###\s/, releaseIdx + 1)
  const sectionEndIdx = sectionEnd(lines, releaseIdx, /^##\s/)
  const insertAt = firstVersion >= 0 && firstVersion < sectionEndIdx ? firstVersion : releaseIdx + 1
  if (insertAt === releaseIdx + 1 && lines[insertAt]?.trim()) block.unshift('')
  if (insertAt > 0 && lines[insertAt - 1].trim()) block.unshift('')
  lines.splice(insertAt, 0, ...block)
  return { content: lines.join('\n'), outcome: 'inserted' }
}
