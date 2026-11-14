/**
 * Getting notes out of NoteFlare:
 * - Markdown export: readable files with frontmatter that the importer reads back.
 * - Encrypted backup: the ciphertext and wrapped keys exactly as the server stores them,
 *   so the file is as unreadable as the database without the passphrase.
 */
import type { EncryptedNote, VaultRecord } from '../../shared/types'
import { decryptNote } from './crypto'
import type { ParsedNote } from './importMarkdown'
import type { Note } from './noteModel'
import type { ZipEntry } from './zip'

const ATTACHMENT_URL = /\/api\/blobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi

// ---------------------------------------------------------------- Markdown

/** Markdown with YAML frontmatter; the same format the CLI's `export` writes. */
export function toMarkdownFile(n: Note): string {
  const lines = ['---', `title: ${JSON.stringify(n.title)}`]
  if (n.labels.length) lines.push(`tags: [${n.labels.map((l) => JSON.stringify(l)).join(', ')}]`)
  if (n.color !== 'default') lines.push(`color: ${n.color}`)
  if (n.pinned) lines.push('pinned: true')
  if (n.archived) lines.push('archived: true')
  lines.push(`created: ${new Date(n.createdAt).toISOString()}`, `updated: ${new Date(n.updatedAt).toISOString()}`, '---', '', n.body, '')
  return lines.join('\n')
}

const firstLine = (s: string) =>
  s
    .split('\n')
    .find((l) => l.trim())
    ?.replace(/^[#>\-*\s[\]x]+/, '')
    .slice(0, 60) ?? ''
const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100) || 'note'

/**
 * One .md file per note that is not in the trash, with unique names. A label like "work/q4"
 * becomes a folder. `attachments` maps an attachment id to its file name in `<root>/attachments/`;
 * links to those are rewritten to relative paths so the images show in any Markdown viewer.
 */
export function markdownEntries(notes: Note[], root = 'NoteFlare', attachments?: ReadonlyMap<string, string>): ZipEntry[] {
  const enc = new TextEncoder()
  const used = new Set<string>()
  return notes
    .filter((n) => !n.trashedAt)
    .map((n) => {
      const folder = [root, ...(n.labels.find((l) => l.includes('/'))?.split('/').map(safeName) ?? [])].join('/')
      const base = safeName(n.title || firstLine(n.body) || n.id.slice(0, 8))
      let name = base
      for (let i = 2; used.has(`${folder}/${name}`.toLowerCase()); i++) name = `${base} (${i})`
      used.add(`${folder}/${name}`.toLowerCase())
      const up = '../'.repeat(folder.split('/').length - 1)
      const body = attachments
        ? n.body.replace(ATTACHMENT_URL, (url, id: string) => {
            const file = attachments.get(id.toLowerCase())
            return file ? `${up}attachments/${file}` : url
          })
        : n.body
      return { name: `${folder}/${name}.md`, data: enc.encode(toMarkdownFile({ ...n, body })), modifiedAt: n.updatedAt }
    })
}

// ---------------------------------------------------------------- encrypted backup

export const BACKUP_FORMAT = 'noteflare-backup'

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: 1
  exportedAt: string
  /** The wrapped keys. Useless without the passphrase or the recovery code. */
  vault: VaultRecord
  notes: EncryptedNote[]
}

export function buildBackup(vault: VaultRecord, notes: EncryptedNote[], now = new Date()): BackupFile {
  return { format: BACKUP_FORMAT, version: 1, exportedAt: now.toISOString(), vault, notes }
}

export class InvalidBackupError extends Error {
  constructor() {
    super('Not a NoteFlare backup')
    this.name = 'InvalidBackupError'
  }
}

export function parseBackup(text: string): BackupFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new InvalidBackupError()
  }
  const b = data as Partial<BackupFile> | null
  const ok =
    !!b &&
    b.format === BACKUP_FORMAT &&
    b.version === 1 &&
    !!b.vault &&
    typeof b.vault.wrappedDek === 'string' &&
    typeof b.vault.recoveryDek === 'string' &&
    !!b.vault.kdf &&
    Array.isArray(b.notes) &&
    b.notes.every((n) => !!n && typeof n.id === 'string' && typeof n.ciphertext === 'string' && typeof n.iv === 'string')
  if (!ok) throw new InvalidBackupError()
  return b as BackupFile
}

/** True when `dek` is the key this backup was made with. */
export async function canDecryptBackup(backup: BackupFile, dek: CryptoKey): Promise<boolean> {
  const first = backup.notes[0]
  if (!first) return true
  try {
    await decryptNote(dek, first.id, first.ciphertext, first.iv)
    return true
  } catch {
    return false
  }
}

/**
 * Decrypt a backup into notes the importer can add. Notes that were in the trash are
 * left out; a note that fails to decrypt is counted, not fatal.
 */
export async function decryptBackup(backup: BackupFile, dek: CryptoKey): Promise<{ notes: ParsedNote[]; failed: number }> {
  const notes: ParsedNote[] = []
  let failed = 0
  for (const row of backup.notes) {
    if (row.trashedAt) continue
    try {
      const payload = await decryptNote(dek, row.id, row.ciphertext, row.iv)
      notes.push({
        ...payload,
        pinned: !!row.pinned,
        archived: !!row.archived,
        modifiedAt: Number.isFinite(row.position) ? row.position : Date.now(),
        sourcePath: row.id,
      })
    } catch {
      failed++
    }
  }
  return { notes, failed }
}

// ---------------------------------------------------------------- download

export function downloadFile(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const exportStamp = (d = new Date()) => d.toISOString().slice(0, 10)
