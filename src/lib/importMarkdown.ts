/**
 * Import Markdown from folders/files the user drops or picks.
 * Everything is read and parsed in the browser; only ciphertext is uploaded.
 */
import { ATTACHMENT_TYPES } from '../../shared/types'
import { NOTE_COLORS, type NoteColor, type NotePayload } from './crypto'
import { readZip } from './zip'

export interface SourceFile {
  /** Relative path, e.g. "Vault/Work/plan.md". */
  path: string
  file: File
}

/** An image listed by the source note, still to be uploaded (Google Keep). */
export interface ImportImage {
  /** File name as the export lists it; the file sits next to the note's file. */
  name: string
  /** MIME type as the export states it. */
  type: string
}

export interface ParsedNote extends NotePayload {
  pinned: boolean
  archived: boolean
  /** Original last edit: orders the list and is shown until the note is edited. */
  modifiedAt: number
  /** Original creation date, when the source has one. */
  createdAt?: number
  sourcePath: string
  images?: ImportImage[]
}

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i
/** Tool/system folders common in Obsidian vaults, git repos… */
const SKIP_DIR = /^(\.git|\.obsidian|\.trash|\.github|node_modules|__MACOSX)$/i
export const MAX_IMPORT_CHARS = 350_000 // fits the API's 512 KB ciphertext limit
/** A whole-account export file (Evernote, Simplenote, Standard Notes) can hold thousands of notes. */
export const MAX_EXPORT_BYTES = 100 * 1024 * 1024
const MAX_LABEL = 40

const inSkippedDir = (path: string) => path.split('/').some((seg) => SKIP_DIR.test(seg) || seg.startsWith('._'))

export const isMarkdownPath = (path: string) => MD_EXT.test(path) && !inSkippedDir(path)
/** Google Keep (Takeout) writes one .json file per note; see importKeep.ts. */
export const isKeepPath = (path: string) => /\.json$/i.test(path) && !inSkippedDir(path)
/** Evernote export (one file, many notes); see importEvernote.ts. */
export const isEnexPath = (path: string) => /\.enex$/i.test(path) && !inSkippedDir(path)
/**
 * A .txt that may hold a JSON export: Standard Notes names its decrypted backup
 * "Standard Notes Backup and Import File.txt". Inside a .zip every .txt is tried.
 */
export const isTextExportPath = (path: string, inZip = false) =>
  /\.txt$/i.test(path) && (inZip || /standard notes/i.test(path.split('/').pop()!)) && !inSkippedDir(path)
/** An export packed as a .zip (Standard Notes, Simplenote, Google Takeout…): unpacked in the browser. */
export const isZipPath = (path: string) => /\.zip$/i.test(path) && !inSkippedDir(path)
export const isImportMediaPath = (path: string) => /\.(png|jpe?g|gif|webp|avif)$/i.test(path) && !inSkippedDir(path)
export const isImportablePath = (path: string) =>
  isMarkdownPath(path) || isKeepPath(path) || isEnexPath(path) || isTextExportPath(path) || isZipPath(path) || isImportMediaPath(path)

/**
 * Replace each .zip with the importable files inside it ("Backup.zip/notes.json"). A zip over
 * MAX_EXPORT_BYTES is kept as is, so the caller counts it as too large.
 */
export async function expandZips(files: SourceFile[]): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  for (const f of files) {
    if (!isZipPath(f.path) || f.file.size > MAX_EXPORT_BYTES) {
      out.push(f)
      continue
    }
    const want = (name: string) =>
      !isZipPath(name) &&
      (isMarkdownPath(name) || isKeepPath(name) || isEnexPath(name) || isTextExportPath(name, true) || isImportMediaPath(name))
    for (const e of await readZip(new Uint8Array(await f.file.arrayBuffer()), want, MAX_EXPORT_BYTES)) {
      const path = `${f.path}/${e.name}`
      out.push({ path, file: new File([e.data], path.split('/').pop()!, { lastModified: e.modifiedAt }) })
    }
  }
  return out
}

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
 * - YAML frontmatter: `title`, `tags`/`labels`, `color`, `pinned`, `archived`, `created`/`date`, `updated`/`modified` (the rest is dropped)
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
  if (folder) labels.add(folderLabel(folder))

  return {
    title: title.slice(0, 300),
    body: text.replace(/^\n+/, '').replace(/\s+$/, ''),
    color: NOTE_COLORS.includes(meta.color as NoteColor) ? (meta.color as NoteColor) : 'default',
    labels: [...labels],
    pinned: isTrue(meta.pinned),
    archived: isTrue(meta.archived),
    // Our own export writes `created` / `updated`; other apps often write `date`.
    modifiedAt: metaDate(meta.updated) ?? metaDate(meta.modified) ?? modifiedAt,
    createdAt: metaDate(meta.created) ?? metaDate(meta.date),
    sourcePath: path,
  }
}

/** A folder path as a label. When it is too long, keep whole folder names from the end instead of cutting one in half. */
function folderLabel(folder: string): string {
  if (folder.length <= MAX_LABEL) return folder
  const parts = folder.split('/')
  let label = parts[parts.length - 1].slice(0, MAX_LABEL)
  for (let i = parts.length - 2; i >= 0 && `${parts[i]}/${label}`.length <= MAX_LABEL; i--) label = `${parts[i]}/${label}`
  return label
}

/** A frontmatter date (ISO or other `Date.parse` text) in ms, or undefined. */
function metaDate(v: string | string[] | undefined): number | undefined {
  const ts = typeof v === 'string' ? Date.parse(v.replace(/^["']|["']$/g, '')) : NaN
  return Number.isFinite(ts) ? ts : undefined
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

/** Strip surrounding quotes; a double-quoted value may use JSON escapes (what the exporters write). */
function unquote(s: string): string {
  const v = s.trim()
  if (/^".*"$/.test(v)) {
    try {
      const parsed: unknown = JSON.parse(v)
      if (typeof parsed === 'string') return parsed
    } catch {
      /* not JSON: fall through and just drop the quotes */
    }
  }
  return v.replace(/^(['"])(.*)\1$/, '$2')
}
const isTrue = (v: unknown) => typeof v === 'string' && /^(true|yes|1)$/i.test(v)

/** A usable date in ms, or undefined. */
export const validDate = (ts: number) => (Number.isFinite(ts) && ts > 0 ? ts : undefined)

/** Duplicate key: same title + body counts as already imported. */
const BLOB_IMAGE = /!\[([^\]]*)\]\(\/api\/blobs\/[0-9a-f-]{36}(?:#[^)\s]*)?\)/gi
/** The alt text an uploaded image gets from its file name (must match `uploadAttachment`). */
export const imageAlt = (fileName: string) => fileName.replace(/\.[^.]+$/, '').replace(/[[\]\n\r]/g, ' ').trim() || 'image'
const textOnly = (body: string) => body.replace(BLOB_IMAGE, '').trim()
const textKey = (n: Pick<NotePayload, 'title' | 'body'>) => `${n.title.trim()}\u0000${textOnly(n.body)}`
/** Duplicate key: same title + text + image names counts as already imported (blob ids differ per upload, so they are left out). */
type Keyed = Pick<NotePayload, 'title' | 'body'> & { images?: ImportImage[] }
/** Names of the note's attachment images: those in its body, then those still to upload (types the app can't show are never uploaded). */
const imageNames = (n: Keyed) => {
  const isSupported = (i: ImportImage) => !i.type || (ATTACHMENT_TYPES as readonly string[]).includes(i.type)
  return [...n.body.matchAll(BLOB_IMAGE)].map((m) => m[1]).concat((n.images ?? []).filter(isSupported).map((i) => imageAlt(i.name)))
}
export const dedupeKey = (n: Keyed) => {
  const names = imageNames(n)
  return names.length ? `${textKey(n)}\u0000${names.join('\u0000')}` : textKey(n)
}
/** The parsed notes that are not already there (and not twice in `parsed`). */
export function freshNotes(parsed: ParsedNote[], existing: Iterable<Pick<NotePayload, 'title' | 'body'>>): ParsedNote[] {
  const seen = new Set<string>()
  const byText = new Map<string, string[][]>() // image names of each existing note with that title and text
  for (const n of existing) {
    seen.add(dedupeKey(n))
    const key = textKey(n)
    byText.set(key, [...(byText.get(key) ?? []), imageNames(n)])
  }
  return parsed.filter((p) => {
    const key = dedupeKey(p)
    if (seen.has(key)) return false
    if (p.images?.length) {
      // An earlier import that had to skip some or all of this note's images stored the note without them.
      const mine = new Set(imageNames(p))
      const hasText = !!(p.title.trim() || textOnly(p.body))
      const stored = byText.get(textKey(p)) ?? []
      if (stored.some((theirs) => (theirs.length > 0 || hasText) && theirs.every((name) => mine.has(name)))) return false
    }
    seen.add(key)
    return true
  })
}
