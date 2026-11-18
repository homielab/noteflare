/**
 * On-device cache of attachment blobs, in its own IndexedDB database. It holds exactly
 * what the server holds: ciphertext. Nothing decrypted is ever written here, so the
 * cache stays unreadable without the passphrase and survives locking.
 *
 * Thumbnails are small and always kept. Full images share a size cap; past it the least
 * recently used ones go first. An image seen once therefore shows offline and is not
 * downloaded again.
 *
 * If IndexedDB isn't available (some private modes), every call degrades to a no-op.
 */
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'

export type BlobKind = 'thumb' | 'full'

/** Total size of full images kept on the device. */
export const MAX_CACHED_FULL_BYTES = 200 * 1024 * 1024

interface Entry {
  id: string
  kind: BlobKind
  size: number
  /** Order of last use: higher is more recent. */
  used: number
}

interface Schema extends DBSchema {
  /** Ciphertext, by blob id. */
  data: { key: string; value: Uint8Array }
  /** Size and last use of each blob, kept apart so eviction never reads the ciphertext. */
  entries: { key: string; value: Entry }
}

export interface BlobCache {
  /** The cached ciphertext, marked as just used; null when it isn't on this device. */
  get(id: string): Promise<Uint8Array | null>
  /** Keep a blob's ciphertext. A full image larger than the cap is not kept. */
  put(id: string, data: Uint8Array, kind: BlobKind): Promise<void>
  delete(ids: string[]): Promise<void>
  clear(): Promise<void>
  /** Empty the cache, close it and delete the database. Later calls are no-ops. */
  destroy(): Promise<void>
}

export function createBlobCache(name = 'noteflare-blobs', opts: { maxFullBytes?: number } = {}): BlobCache {
  const maxFullBytes = opts.maxFullBytes ?? MAX_CACHED_FULL_BYTES
  let dbp: Promise<IDBPDatabase<Schema> | null> | null = null
  let lastUsed = 0
  /** Strictly increasing, so two uses in the same millisecond still have an order. */
  const tick = () => (lastUsed = Math.max(Date.now(), lastUsed + 1))

  const db = () =>
    (dbp ??= (async () => {
      try {
        if (typeof indexedDB === 'undefined') return null
        return await openDB<Schema>(name, 1, {
          upgrade(d) {
            d.createObjectStore('data')
            d.createObjectStore('entries', { keyPath: 'id' })
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

  async function run<T>(fallback: T, fn: (d: IDBPDatabase<Schema>) => Promise<T>): Promise<T> {
    const d = await db()
    if (!d) return fallback
    try {
      return await fn(d)
    } catch (err) {
      console.warn('Attachment cache error', err)
      return fallback
    }
  }

  const cache: BlobCache = {
    get: (id) =>
      run(null, async (d) => {
        const tx = d.transaction(['data', 'entries'], 'readwrite')
        const data = await tx.objectStore('data').get(id)
        const entry = await tx.objectStore('entries').get(id)
        if (data && entry) await tx.objectStore('entries').put({ ...entry, used: tick() })
        await tx.done
        return data && entry ? data : null
      }),
    put: (id, data, kind) =>
      run(undefined, async (d) => {
        if (kind === 'full' && data.byteLength > maxFullBytes) return
        const tx = d.transaction(['data', 'entries'], 'readwrite')
        const entries = tx.objectStore('entries')
        const known = await entries.get(id)
        // A blob once known as a thumbnail stays one: thumbnails are never evicted.
        const entry: Entry = { id, kind: known?.kind === 'thumb' ? 'thumb' : kind, size: data.byteLength, used: tick() }
        await tx.objectStore('data').put(data, id)
        await entries.put(entry)
        if (entry.kind === 'full') {
          const full = (await entries.getAll()).filter((e) => e.kind === 'full').sort((a, b) => a.used - b.used)
          let total = full.reduce((sum, e) => sum + e.size, 0)
          for (const old of full) {
            if (total <= maxFullBytes) break
            if (old.id === id) continue
            await tx.objectStore('data').delete(old.id)
            await entries.delete(old.id)
            total -= old.size
          }
        }
        await tx.done
      }),
    delete: (ids) =>
      run(undefined, async (d) => {
        if (!ids.length) return
        const tx = d.transaction(['data', 'entries'], 'readwrite')
        await Promise.all([...ids.flatMap((id) => [tx.objectStore('data').delete(id), tx.objectStore('entries').delete(id)]), tx.done])
      }),
    clear: () =>
      run(undefined, async (d) => {
        const tx = d.transaction(['data', 'entries'], 'readwrite')
        await Promise.all([tx.objectStore('data').clear(), tx.objectStore('entries').clear(), tx.done])
      }),
    async destroy() {
      // Empty first: deleting can stay blocked by a tab that doesn't let go.
      await cache.clear()
      const d = await db()
      dbp = Promise.resolve(null)
      d?.close()
      if (typeof indexedDB === 'undefined') return
      await Promise.race([deleteDB(name).catch(() => {}), new Promise((r) => setTimeout(r, 2000))])
    },
  }
  return cache
}

/** The app-wide cache. */
export const blobCache = createBlobCache()
