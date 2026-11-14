/**
 * Plain-text editing helpers for the Markdown note editor. Each returns the
 * slice of text to replace and where the selection should land afterwards, so
 * the editor can apply it as one native edit (keeping the browser's undo).
 */

export interface Edit {
  /** Replace value.slice(from, to) with `text`. */
  from: number
  to: number
  text: string
  /** Selection after the edit, in the new value. */
  selStart: number
  selEnd: number
}

const LIST_RE = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/

const lineStart = (v: string, i: number) => v.lastIndexOf('\n', i - 1) + 1
const lineEnd = (v: string, i: number) => {
  const e = v.indexOf('\n', i)
  return e === -1 ? v.length : e
}

/**
 * Enter inside a list item: start the next item ("- ", "- [ ] ", "3. ").
 * Enter on an empty item: end the list instead. Returns null when the cursor
 * isn't in a list item, so the editor inserts a plain newline.
 */
export function continueList(value: string, start: number, end: number): Edit | null {
  if (start !== end) return null
  const ls = lineStart(value, start)
  const line = value.slice(ls, lineEnd(value, start))
  const m = LIST_RE.exec(line)
  if (!m || start < ls + m[0].length) return null

  const [prefix, indent, , num, delim, gap, task] = m
  if (line.slice(prefix.length).trim() === '') {
    // Empty item: remove its marker and end the list.
    return { from: ls, to: ls + line.length, text: '', selStart: ls, selEnd: ls }
  }
  const marker = num ? `${Number(num) + 1}${delim}` : m[2]
  const next = `\n${indent}${marker}${gap}${task ? '[ ] ' : ''}`
  return { from: start, to: end, text: next, selStart: start + next.length, selEnd: start + next.length }
}

/** Tab / Shift+Tab: indent or outdent every line the selection touches by two spaces. */
export function indentLines(value: string, start: number, end: number, outdent: boolean): Edit {
  const from = lineStart(value, start)
  const to = lineEnd(value, end > start && value[end - 1] === '\n' ? end - 1 : end)
  const lines = value.slice(from, to).split('\n')
  let firstDelta = 0
  let total = 0
  const out = lines.map((l, i) => {
    let d: number
    let next: string
    if (outdent) {
      const n = l.startsWith('  ') ? 2 : l.startsWith(' ') || l.startsWith('\t') ? 1 : 0
      next = l.slice(n)
      d = -n
    } else {
      next = '  ' + l
      d = 2
    }
    if (i === 0) firstDelta = d
    total += d
    return next
  })
  const text = out.join('\n')
  const selStart = Math.max(from, start + firstDelta)
  return { from, to, text, selStart, selEnd: start === end ? selStart : end + total }
}

/**
 * Turns the selected lines into a checklist, or back into plain lines when
 * they all are checklist items already. Bullets become checklist items.
 */
export function toggleChecklist(value: string, start: number, end: number): Edit {
  const from = lineStart(value, start)
  const to = lineEnd(value, end > start && value[end - 1] === '\n' ? end - 1 : end)
  const lines = value.slice(from, to).split('\n')
  const isTask = (l: string) => {
    const m = LIST_RE.exec(l)
    return !!m && !!m[6]
  }
  const content = lines.filter((l) => l.trim())
  const remove = content.length > 0 && content.every(isTask)

  const out = lines.map((l) => {
    if (!l.trim() && lines.length > 1) return l
    const m = LIST_RE.exec(l)
    if (remove) return m ? m[1] + l.slice(m[0].length) : l
    if (m && m[6]) return l
    if (m) return `${m[1]}${m[3] ? '-' : m[2]} [ ] ${l.slice(m[0].length)}`
    const indent = /^\s*/.exec(l)![0]
    return `${indent}- [ ] ${l.slice(indent.length)}`
  })
  const text = out.join('\n')
  // A collapsed cursor stays at the end of its line's text; a selection covers the edited lines.
  if (start === end) {
    const delta = text.length - (to - from)
    const pos = lines.length === 1 ? Math.max(from, start + delta) : from + text.length
    return { from, to, text, selStart: pos, selEnd: pos }
  }
  return { from, to, text, selStart: from, selEnd: from + text.length }
}

/** Applies an edit to a string (used by tests and as a fallback). */
export function applyEdit(value: string, e: Edit) {
  return value.slice(0, e.from) + e.text + value.slice(e.to)
}
