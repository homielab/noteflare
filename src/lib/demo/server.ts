/**
 * The demo build's backend: answers the app's API calls from an IndexedDB database
 * of its own, with the same version rules as the Worker. Nothing leaves the browser.
 * Only bundled when VITE_DEMO=1 (see src/lib/api.ts).
 */
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { BatchNoteItem, BatchResult, EncryptedNote, MeResponse, PutNoteBody, VaultRecord } from '../../../shared/types'
import type { VersionInfo } from '../../../shared/release'
import { APP_VERSION } from '../../../shared/version'
import { ApiError } from '../api'
import { createVault, encryptNote } from '../crypto'
import { emptyNote, toPayload } from '../noteModel'
import { DEMO_EMAIL, DEMO_PASSPHRASE, sampleNotes } from './content'

interface Schema extends DBSchema {
  notes: { key: string; value: EncryptedNote }
  kv: { key: string; value: unknown }
}

export const DEMO_SERVER_DB = 'noteflare-demo-server'

export interface DemoServer {
  handle(method: string, path: string, body?: unknown): Promise<unknown>
  /** Delete the database; the next request seeds the sample notes again. */
  reset(): Promise<void>
}

export function createDemoServer(name = DEMO_SERVER_DB, lang: () => string = () => 'en'): DemoServer {
  let dbp: Promise<IDBPDatabase<Schema>> | null = null
  let seeding: Promise<void> | null = null
  let clock = 0
  /** Strictly increasing, so `since` pulls never miss a write made in the same millisecond. */
  const now = () => (clock = Math.max(clock + 1, Date.now()))

  const db = () =>
    (dbp ??= openDB<Schema>(name, 1, {
      upgrade(d) {
        d.createObjectStore('notes', { keyPath: 'id' })
        d.createObjectStore('kv')
      },
      blocking(_c, _n, e) {
        ;(e.target as IDBDatabase).close()
      },
    }))

  /** First visit (or after a reset): a vault with the demo passphrase and the sample notes. */
  const ensureSeeded = () =>
    (seeding ??= (async () => {
      const d = await db()
      if (await d.get('kv', 'vault')) return
      const { record, dek } = await createVault(DEMO_PASSPHRASE)
      const t = now()
      const rows = await Promise.all(
        sampleNotes(lang()).map(async (s, i) => {
          const note = { ...emptyNote(), ...s, position: t - i * 1000 }
          const { ciphertext, iv } = await encryptNote(dek, note.id, toPayload(note))
          const row: EncryptedNote = {
            id: note.id,
            ciphertext,
            iv,
            pinned: note.pinned,
            archived: note.archived,
            trashedAt: note.trashedAt,
            position: note.position,
            version: 1,
            createdAt: t - i * 3_600_000,
            updatedAt: t,
          }
          return row
        }),
      )
      const tx = d.transaction(['notes', 'kv'], 'readwrite')
      await Promise.all([
        ...rows.map((r) => tx.objectStore('notes').put(r)),
        tx.objectStore('kv').put({ ...record, version: 1, passkeys: [] }, 'vault'),
        tx.done,
      ])
    })().finally(() => (seeding = null)))

  const fail = (status: number, body: unknown = { error: 'not_in_demo' }): never => {
    throw new ApiError(status, body)
  }

  async function handle(method: string, fullPath: string, body?: unknown): Promise<unknown> {
    const [path, query = ''] = fullPath.split('?')
    const d = await db()
    if (path === '/setup' && method === 'GET') return { needed: false }
    if (path === '/version') {
      const info: VersionInfo = { version: APP_VERSION, checkEnabled: false, latest: null, updateAvailable: false, checkedAt: null, canUpdate: false }
      return info
    }
    await ensureSeeded()
    if (path === '/me') {
      const me: MeResponse = { email: DEMO_EMAIL, hasVault: true, auth: 'session', scope: 'write', attachments: false }
      return me
    }
    if (path === '/vault' && method === 'GET') return (await d.get('kv', 'vault')) ?? fail(404, { error: 'not_found' })
    if (path === '/vault' && method === 'PUT') {
      const next = body as VaultRecord
      const cur = (await d.get('kv', 'vault')) as VaultRecord
      if (next.version !== cur.version) return fail(409, { error: 'conflict' })
      await d.put('kv', { ...next, version: cur.version + 1, passkeys: [] }, 'vault')
      return { version: cur.version + 1 }
    }
    if (path === '/notes' && method === 'GET') {
      const since = Number(new URLSearchParams(query).get('since') ?? 0) || 0
      return (await d.getAll('notes')).filter((n) => n.updatedAt > since).sort((a, b) => a.updatedAt - b.updatedAt)
    }
    if (path === '/notes/index') return (await d.getAll('notes')).map(({ id, version }) => ({ id, version }))
    if (path === '/notes/batch' && method === 'POST') {
      const out: BatchResult = { created: [], skipped: [] }
      const t = now()
      for (const n of (body as { notes: BatchNoteItem[] }).notes) {
        if (await d.get('notes', n.id)) {
          out.skipped.push(n.id)
          continue
        }
        await d.put('notes', { id: n.id, ciphertext: n.ciphertext, iv: n.iv, pinned: n.pinned, archived: n.archived, trashedAt: n.trashedAt, position: n.position, version: 1, createdAt: t, updatedAt: t })
        out.created.push({ id: n.id, version: 1, createdAt: t, updatedAt: t })
      }
      return out
    }
    const m = path.match(/^\/notes\/([^/]+)$/)
    if (m) {
      const id = decodeURIComponent(m[1])
      const cur = await d.get('notes', id)
      if (method === 'GET') return cur ?? fail(404, { error: 'not_found' })
      if (method === 'DELETE') {
        if (!cur || cur.trashedAt === null) return fail(404, { error: 'not_found' })
        await d.delete('notes', id)
        return undefined
      }
      if (method === 'PUT') {
        const b = body as PutNoteBody
        const ok = b.baseVersion === 0 ? !cur : !!cur && cur.version === b.baseVersion
        if (!ok) return cur ? fail(409, { error: 'conflict', current: cur }) : fail(404, { error: 'not_found' })
        const t = now()
        const row: EncryptedNote = {
          id,
          ciphertext: b.ciphertext,
          iv: b.iv,
          pinned: b.pinned,
          archived: b.archived,
          trashedAt: b.trashedAt,
          position: b.position,
          version: (cur?.version ?? 0) + 1,
          createdAt: cur?.createdAt ?? t,
          updatedAt: t,
        }
        await d.put('notes', row)
        return row
      }
    }
    // Shares, tokens, passkeys, backups, update, attachments: they need a server.
    if (path === '/backups') return { backups: [] }
    if (method === 'GET' && (path === '/shares' || path === '/tokens')) return []
    return fail(404)
  }

  return {
    handle,
    async reset() {
      const d = await db()
      d.close()
      dbp = null
      await deleteDB(name)
    },
  }
}
