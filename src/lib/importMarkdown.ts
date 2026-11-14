/**
 * Import Markdown from folders/files the user drops or picks.
 * Everything is read and parsed in the browser; only ciphertext is uploaded.
 */
import { NOTE_COLORS, type NoteColor, type NotePayload } from './crypto'

export interface SourceFile {
  /** Relative path, e.g. "Vault/Work/plan.md". */
  path: string
  file: File
}

export interface ParsedNote extends NotePayload {
  pinned: boolean
  archived: boolean
  /** Used for ordering: most recently modified files first. */
  modifiedAt: number
  sourcePath: string
}

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i
/** Tool/system folders common in Obsidian vaults, git repos… */
const SKIP_DIR = /^(\.git|\.obsidian|\.trash|\.github|node_modules|__MACOSX)$/i
export const MAX_IMPORT_CHARS = 350_000 // fits the API's 512 KB ciphertext limit
const MAX_LABEL = 40

const inSkippedDir = (path: string) => path.split('/').some((seg) => SKIP_DIR.test(seg) || seg.startsWith('._'))

export const isMarkdownPath = (path: string) => MD_EXT.test(path) && !inSkippedDir(path)
/** Google Keep (Takeout) writes one .json file per note; see importKeep.ts. */
export const isKeepPath = (path: string) => /\.json$/i.test(path) && !inSkippedDir(path)
export const isImportablePath = (path: string) => isMarkdownPath(path) || isKeepPath(path)

// ------------------------------------------------------------- collecting files

/** Every importable file from a drop (folders are walked recursively). */
export async function filesFromDrop(dt: DataTransfer): Promise<SourceFile[]> {
  const entries = Array.from(dt.items)
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e)

  if (!entries.length) {
    return Array.from(dt.files)
      .map((file) => ({ path: file.name, file }))
      .filter((f) => isImportablePath(f.path))
  }
  const out: SourceFile[] = []
  for (const entry of entries) await walk(entry, out)
  return out.filter((f) => isImportablePath(f.path))
}

/** From <input type="file" webkitdirectory> or a multi-file picker. */
export function filesFromInput(list: FileList): SourceFile[] {
  return Array.from(list)
    .map((file) => ({ path: file.webkitRelativePath || file.name, file }))
    .filter((f) => isImportablePath(f.path))
}

async function walk(entry: FileSystemEntry, out: SourceFile[]): Promise<void> {
  const path = entry.fullPath.replace(/^\/+/, '')
  if (entry.isFile) {
    if (!isImportablePath(path)) return
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
    out.push({ path, file })
    return
  }
  if (!entry.isDirectory || SKIP_DIR.test(entry.name)) return
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // readEntries returns batches (Chrome: up to 100); call until empty.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
    if (!batch.length) break
    for (const child of batch) await walk(child, out)
  }
}

// ------------------------------------------------------------- parsing

/**
 * Turn a Markdown file into a note:
 * - YAML frontmatter: `title`, `tags`/`labels`, `color`, `pinned`, `archived` (the rest is dropped)
 * - title: frontmatter → first `# Heading` → file name
 * - labels: tags + the file's folder (relative to the dropped folder)
 */
export function parseMarkdown(path: string, raw: string, modifiedAt = Date.now()): ParsedNote {
  let text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const meta: Record<string, string | string[]> = {}

  const fm = text.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/)
  if (fm) {
    Object.assign(meta, parseFrontmatter(fm[1]))
    text = text.slice(fm[0].length)
  }

  let title = typeof meta.title === 'string' ? meta.title : ''
  if (!title) {
    const h1 = text.match(/^\s*#[ \t]+(.+?)[ \t#]*(?:\n|$)/)
    if (h1) {
      title = h1[1].trim()
      text = text.slice(h1[0].length)
    }
  }
  const segments = path.split('/')
  const fileName = segments[segments.length - 1]
  if (!title) title = fileName.replace(MD_EXT, '')

  const labels = new Set<string>()
  for (const key of ['tags', 'tag', 'labels']) {
    const v = meta[key]
    for (const t of Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : []) {
      const clean = t.replace(/^#/, '').trim()
      if (clean) labels.add(clean.slice(0, MAX_LABEL))
    }
  }
  // Drop the root (the dropped folder) and the file name; what is in between becomes a label.
  const folder = segments.slice(1, -1).join('/')
  if (folder) labels.add(folder.slice(-MAX_LABEL))

  return {
    title: title.slice(0, 300),
    body: text.replace(/^\n+/, '').replace(/\s+$/, ''),
    color: NOTE_COLORS.includes(meta.color as NoteColor) ? (meta.color as NoteColor) : 'default',
    labels: [...labels],
    pinned: isTrue(meta.pinned),
    archived: isTrue(meta.archived),
    modifiedAt,
    sourcePath: path,
  }
}

/** Minimal YAML: `key: value`, `key: [a, b]` and `- item` lists. */
function parseFrontmatter(src: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  let listKey: string | null = null
  for (const line of src.split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$|^-\s+(.*)$/)
    if (item && listKey) {
      const prev = out[listKey]
      out[listKey] = [...(Array.isArray(prev) ? prev : []), unquote(item[1] ?? item[2])]
      continue
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()
    listKey = null
    if (!value) {
      listKey = key
      out[key] = []
    } else if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value.slice(1, -1).split(',').map(unquote).filter(Boolean)
    } else {
      out[key] = unquote(value)
    }
  }
  return out
}

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2')
const isTrue = (v: unknown) => typeof v === 'string' && /^(true|yes|1)$/i.test(v)

/** Duplicate key: same title + body counts as already imported. */
export const dedupeKey = (n: Pick<NotePayload, 'title' | 'body'>) => `${n.title.trim()}\u0000${n.body.trim()}`
