/**
 * On-device cache in IndexedDB. It holds exactly what the server holds —
 * ciphertext and the wrapped vault keys — plus the queue of changes not yet
 * synced. Nothing here is readable without the passphrase.
 *
 * If IndexedDB isn't available (some private modes), every call degrades to a
 * no-op and NoteFlare simply runs online-only.
 */
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { EncryptedNote, PutNoteBody, VaultRecord } from '../../../shared/types'

export type OutboxEntry =
  | {
      id: string
      kind: 'put'
      body: PutNoteBody
      seq: number
      /** The server copy this edit started from, for a three-way merge on conflict. */
      base?: EncryptedNote
    }
  | { id: string; kind: 'delete'; seq: number }

export interface Meta {
  email: string
  hasVault: boolean
  /** Server `updatedAt` of the newest change pulled so far. */
  lastSync: number
}

interface Schema extends DBSchema {
  notes: { key: string; value: EncryptedNote }
  outbox: { key: string; value: OutboxEntry }
  kv: { key: string; value: unknown }
}

export interface LocalStore {
  getMeta(): Promise<Meta | null>
  setMeta(patch: Partial<Meta>): Promise<void>
  getVault(): Promise<VaultRecord | null>
  setVault(v: VaultRecord): Promise<void>
  allNotes(): Promise<EncryptedNote[]>
  putNotes(rows: EncryptedNote[]): Promise<void>
  deleteNotes(ids: string[]): Promise<void>
  allOutbox(): Promise<OutboxEntry[]>
  putOutbox(e: OutboxEntry): Promise<void>
  deleteOutbox(id: string): Promise<void>
  clear(): Promise<void>
  /** Empty the cache, close it and delete the database. Later calls are no-ops. */
  destroy(): Promise<void>
}

export function createLocalStore(name = 'noteflare'): LocalStore {
  let dbp: Promise<IDBPDatabase<Schema> | null> | null = null

  const db = () =>
    (dbp ??= (async () => {
      try {
        if (typeof indexedDB === 'undefined') return null
        return await openDB<Schema>(name, 1, {
          upgrade(d) {
            d.createObjectStore('notes', { keyPath: 'id' })
            d.createObjectStore('outbox', { keyPath: 'id' })
            d.createObjectStore('kv')
          },
          // Another tab is deleting the database (sign-out): let go so it can.
          blocking(_cur, _next, event) {
            ;(event.target as IDBDatabase).close()
          },
        })
      } catch {
        return null
      }
    })())

  /** Run against the database, or return `fallback` if it isn't usable. */
  async function run<T>(fallback: T, fn: (d: IDBPDatabase<Schema>) => Promise<T>): Promise<T> {
    const d = await db()
    if (!d) return fallback
    try {
      return await fn(d)
    } catch (err) {
      console.warn('Local cache error', err)
      return fallback
    }
  }

  const store: LocalStore = {
    getMeta: () => run(null, async (d) => ((await d.get('kv', 'meta')) as Meta | undefined) ?? null),
    setMeta: (patch) =>
      run(undefined, async (d) => {
        const tx = d.transaction('kv', 'readwrite')
        const cur = ((await tx.store.get('meta')) as Meta | undefined) ?? { email: '', hasVault: false, lastSync: 0 }
        await tx.store.put({ ...cur, ...patch }, 'meta')
        await tx.done
      }),
    getVault: () => run(null, async (d) => ((await d.get('kv', 'vault')) as VaultRecord | undefined) ?? null),
    setVault: (v) => run(undefined, async (d) => void (await d.put('kv', v, 'vault'))),
    allNotes: () => run([], (d) => d.getAll('notes')),
    putNotes: (rows) =>
      run(undefined, async (d) => {
        if (!rows.length) return
        const tx = d.transaction('notes', 'readwrite')
        await Promise.all([...rows.map((r) => tx.store.put(r)), tx.done])
      }),
    deleteNotes: (ids) =>
      run(undefined, async (d) => {
        if (!ids.length) return
        const tx = d.transaction('notes', 'readwrite')
        await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
      }),
    allOutbox: () => run([], (d) => d.getAll('outbox')),
    putOutbox: (e) => run(undefined, async (d) => void (await d.put('outbox', e))),
    deleteOutbox: (id) => run(undefined, (d) => d.delete('outbox', id)),
    clear: () =>
      run(undefined, async (d) => {
        const tx = d.transaction(['notes', 'outbox', 'kv'], 'readwrite')
        await Promise.all([
          tx.objectStore('notes').clear(),
          tx.objectStore('outbox').clear(),
          tx.objectStore('kv').clear(),
          tx.done,
        ])
      }),
    async destroy() {
      // Empty first: deleting can stay blocked by a tab that doesn't let go.
      await store.clear()
      const d = await db()
      dbp = Promise.resolve(null)
      d?.close()
      if (typeof indexedDB === 'undefined') return
      await Promise.race([deleteDB(name).catch(() => {}), new Promise((r) => setTimeout(r, 2000))])
    },
  }
  return store
}

/** The app-wide store. */
export const localStore = createLocalStore(import.meta.env.VITE_DEMO === '1' ? 'noteflare-demo' : 'noteflare')
