import type { Note } from './noteModel'

export interface LibraryItem {
  /** Blob id of the attachment itself (lower case). */
  id: string
  kind: 'image' | 'file'
  /** The link target as written in the note, fragment included, e.g. `/api/blobs/<id>#w=800&h=600&t=<thumbId>`. */
  src: string
  /** Image: its alt text. File: the link text without the trailing "(size)". May be ''. */
  name: string
  /** File: the text inside the trailing parentheses of the link text, e.g. "1.2 MB"; null for images or when absent. */
  size: string | null
  /** Notes (not trashed) that contain it, newest first (createdAt desc). */
  notes: Note[]
}

export interface Library {
  images: LibraryItem[]
  files: LibraryItem[]
}

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const LINK_RE = new RegExp(`(!?)\\[([^\\]]*)\\]\\((/api/blobs/(${ID})(?:#[\\w=&.-]*)?)\\)`, 'gi')
const FILE_TEXT_RE = /^(.*\S)\s*\(([^()]*)\)\s*$/

function hasThumb(src: string): boolean {
  const hash = src.indexOf('#')
  if (hash === -1) return false
  return new URLSearchParams(src.slice(hash + 1)).has('t')
}

export function scanLibrary(notes: readonly Note[]): Library {
  const images: LibraryItem[] = []
  const files: LibraryItem[] = []
  const map = new Map<string, LibraryItem>()

  const sortedNotes = notes
    .filter((n) => !n.trashedAt && n.body.includes('/api/blobs/'))
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)

  for (const note of sortedNotes) {
    for (const m of note.body.matchAll(LINK_RE)) {
      const isImg = m[1] === '!'
      const kind: 'image' | 'file' = isImg ? 'image' : 'file'
      const rawText = m[2]
      const src = m[3]
      const id = m[4].toLowerCase()

      let name: string
      let size: string | null = null
      if (isImg) {
        name = rawText.trim()
      } else {
        const fileMatch = FILE_TEXT_RE.exec(rawText)
        if (fileMatch) {
          name = fileMatch[1]
          size = fileMatch[2]
        } else {
          name = rawText.trim()
        }
      }

      const key = `${kind}:${id}`
      const existing = map.get(key)
      if (existing) {
        if (!existing.notes.some((n) => n.id === note.id)) {
          existing.notes.push(note)
        }
        if (existing.name === '' && name !== '') {
          existing.name = name
        }
        if (kind === 'image' && !hasThumb(existing.src) && hasThumb(src)) {
          existing.src = src
        }
      } else {
        const item: LibraryItem = {
          id,
          kind,
          src,
          name,
          size,
          notes: [note],
        }
        map.set(key, item)
        if (kind === 'image') images.push(item)
        else files.push(item)
      }
    }
  }

  return { images, files }
}

export function filterLibrary(
  items: readonly LibraryItem[],
  filter: { query?: string; label?: string | null },
): LibraryItem[] {
  const q = (filter.query ?? '').trim().toLocaleLowerCase()
  const label = filter.label

  return items.filter((item) => {
    const notes = label ? item.notes.filter((n) => n.labels.includes(label)) : item.notes
    if (!notes.length) return false
    if (!q) return true
    if (item.name.toLocaleLowerCase().includes(q)) return true
    return notes.some((n) =>
      `${n.title}\n${n.body}\n${n.labels.join(' ')}`.toLocaleLowerCase().includes(q),
    )
  })
}

export function libraryLabels(items: readonly LibraryItem[]): string[] {
  const set = new Set<string>()
  for (const item of items) {
    for (const note of item.notes) {
      for (const label of note.labels) {
        set.add(label)
      }
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}
