/**
 * Pure text cleanup for ghost-text (inline) completions.
 *
 * Kept free of VS Code imports so the cleanup rules can be unit-tested with
 * plain Node (see test/completionText.test.cjs). Everything here exists
 * because small local models rarely return exactly the insertable text:
 * they wrap it in markdown fences or repeat the line already being typed.
 */

/** Remove a markdown code fence wrapping the whole text, when present. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return text
  const lines = trimmed.split('\n')
  // Drop the opening fence line (``` or ```lang).
  lines.shift()
  // Drop the closing fence line when it is the last remaining line.
  if (lines.length && lines[lines.length - 1].trim() === '```') lines.pop()
  return lines.join('\n')
}

/**
 * Turn a raw model response into text that can be inserted at the cursor,
 * or undefined when nothing insertable remains.
 *
 * `linePrefix` is the current line's text before the cursor (already typed)
 * and `fullLine` the line's whole text; both are needed because models love
 * echoing the line under construction, which would duplicate it on insert.
 */
export function cleanCompletion(raw: string, linePrefix: string, fullLine: string): string | undefined {
  let text = stripCodeFences(raw)

  // The model returned only the line that already exists — nothing to add.
  if (fullLine.trim() && text.trim() === fullLine.trim()) return undefined

  const lines = text.split('\n')
  if (lines.length > 1 && fullLine.trim() && lines[0].trim() === fullLine.trim()) {
    // The first line duplicates the current line (already typed); the rest
    // of the response is the actual completion.
    lines.shift()
    text = lines.join('\n')
  } else if (linePrefix && text.startsWith(linePrefix)) {
    // The completion restarts the current line: cut the part already typed
    // so accepting it does not duplicate the line's beginning.
    text = text.slice(linePrefix.length)
  }

  // Ghost text should not drag trailing blank lines into the buffer.
  text = text.replace(/\s+$/, '')
  return text.trim() ? text : undefined
}
