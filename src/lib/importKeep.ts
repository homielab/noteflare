/**
 * Import notes from a Google Keep export (Google Takeout → Keep).
 * Takeout writes one `.json` file per note; this turns each into the same shape the
 * Markdown importer produces. Attachments (images, audio) are not imported.
 */
import type { NoteColor } from './crypto'
import type { ParsedNote } from './importMarkdown'

const MAX_LABEL = 40

/** Keep's twelve colors mapped to the nearest NoteFlare paper color. */
const KEEP_COLORS: Record<string, NoteColor> = {
  RED: 'rose',
  PINK: 'rose',
  ORANGE: 'clay',
  BROWN: 'clay',
  YELLOW: 'sand',
  GREEN: 'sage',
  TEAL: 'sage',
  BLUE: 'sky',
  CERULEAN: 'sky',
  DARK_BLUE: 'sky',
  PURPLE: 'lilac',
  GRAY: 'slate',
}

interface KeepNote {
  title?: unknown
  textContent?: unknown
  listContent?: unknown
  labels?: unknown
  annotations?: unknown
  color?: unknown
  isPinned?: unknown
  isArchived?: unknown
  isTrashed?: unknown
  userEditedTimestampUsec?: unknown
  createdTimestampUsec?: unknown
}

/** True for JSON that has the shape of a Keep note, so other .json files in a dropped folder are ignored. */
function isKeepNote(v: unknown): v is KeepNote {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as KeepNote
  const hasContent = typeof o.textContent === 'string' || Array.isArray(o.listContent)
  const hasKeepFields = 'isTrashed' in o || 'isArchived' in o || 'userEditedTimestampUsec' in o
  return hasContent && hasKeepFields
}

/**
 * Parse one Takeout file. Returns null when the file is not a Keep note, is in Keep's
 * trash, or is empty.
 */
export function parseKeepNote(path: string, raw: string, modifiedAt = Date.now()): ParsedNote | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isKeepNote(data) || data.isTrashed === true) return null

  const lines: string[] = []
  if (typeof data.textContent === 'string' && data.textContent.trim()) lines.push(data.textContent.replace(/\r\n?/g, '\n').trim())
  if (Array.isArray(data.listContent)) {
    const items = data.listContent
      .filter((i): i is { text?: unknown; isChecked?: unknown } => !!i && typeof i === 'object')
      .map((i) => `- [${i.isChecked === true ? 'x' : ' '}] ${typeof i.text === 'string' ? i.text.replace(/\s*\n\s*/g, ' ') : ''}`)
    if (items.length) lines.push(items.join('\n'))
  }
  // Link previews Keep attached to the note; keep the ones the text doesn't already mention.
  if (Array.isArray(data.annotations)) {
    const text = lines.join('\n')
    const links = data.annotations
      .filter((a): a is { url: string; title?: unknown } => !!a && typeof a === 'object' && typeof (a as { url?: unknown }).url === 'string')
      .filter((a) => /^https?:\/\//i.test(a.url) && !text.includes(a.url))
      .map((a) => (typeof a.title === 'string' && a.title.trim() ? `[${a.title.trim().replace(/[[\]]/g, '')}](${a.url})` : a.url))
    if (links.length) lines.push(links.join('\n'))
  }

  const title = typeof data.title === 'string' ? data.title.trim() : ''
  const body = lines.join('\n\n')
  if (!title && !body) return null

  const labels = Array.isArray(data.labels)
    ? data.labels
        .map((l) => (l && typeof l === 'object' && typeof (l as { name?: unknown }).name === 'string' ? (l as { name: string }).name.trim() : ''))
        .filter(Boolean)
        .map((l) => l.slice(0, MAX_LABEL))
    : []

  const usec = Number(data.userEditedTimestampUsec ?? data.createdTimestampUsec)
  const archived = data.isArchived === true

  return {
    title: title.slice(0, 300),
    body,
    color: KEEP_COLORS[String(data.color)] ?? 'default',
    labels: [...new Set(labels)],
    pinned: data.isPinned === true && !archived,
    archived,
    modifiedAt: Number.isFinite(usec) && usec > 0 ? Math.round(usec / 1000) : modifiedAt,
    sourcePath: path,
  }
}
