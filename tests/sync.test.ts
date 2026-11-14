import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BatchNoteItem, EncryptedNote, PutNoteBody } from '../shared/types'
import { ApiError } from '../src/lib/api'
import { decryptNote, encryptNote } from '../src/lib/crypto'
import { emptyNote } from '../src/lib/noteModel'
import { createLocalStore, type LocalStore } from '../src/lib/sync/localStore'
import { NoteSync, type SyncApi } from '../src/lib/sync/engine'

/** In-memory server with the same version semantics as worker/index.ts. */
class FakeServer implements SyncApi {
  rows = new Map<string, EncryptedNote>()
  mode: 'up' | 'offline' | 'expired' = 'up'
  clock = 1_000
  /** When set, putNote waits for this promise before answering. */
  gate: Promise<void> | null = null

  private check() {
    if (this.mode === 'offline') throw new TypeError('Failed to fetch')
    if (this.mode === 'expired') throw new ApiError(401, null)
  }
  async listNotes(since: number) {
    this.check()
    return [...this.rows.values()].filter((r) => r.updatedAt > since).map((r) => ({ ...r }))
  }
  async noteIndex() {
    this.check()
    return [...this.rows.values()].map((r) => ({ id: r.id, version: r.version }))
  }
  async putNote(id: string, b: PutNoteBody) {
    this.check()
    if (this.gate) await this.gate
    const now = ++this.clock
    const cur = this.rows.get(id)
    const { baseVersion, ...fields } = b
    if (baseVersion === 0) {
      if (cur) throw new ApiError(409, { error: 'conflict', current: { ...cur } })
      const row = { id, ...fields, version: 1, createdAt: now, updatedAt: now }
      this.rows.set(id, row)
      return { ...row }
    }
    if (!cur) throw new ApiError(404, { error: 'not_found' })
    if (cur.version !== baseVersion) throw new ApiError(409, { error: 'conflict', current: { ...cur } })
    const row = { ...cur, ...fields, version: cur.version + 1, updatedAt: now }
    this.rows.set(id, row)
    return { ...row }
  }
  async deleteNote(id: string) {
    this.check()
    if (!this.rows.delete(id)) throw new ApiError(404, { error: 'not_found' })
  }
  async createNotes(items: BatchNoteItem[]) {
    this.check()
    const now = ++this.clock
    const created = items.map((n) => {
      this.rows.set(n.id, { ...n, version: 1, createdAt: now, updatedAt: now })
      return { id: n.id, version: 1, createdAt: now, updatedAt: now }
    })
    return { created, skipped: [] }
  }
}

let dek: CryptoKey
let server: FakeServer
let store: LocalStore
let dbCount = 0
const events: string[] = []
const hooks = {
  onConflict: () => events.push('conflict'),
  onMerged: () => events.push('merged'),
  onRejected: () => events.push('rejected'),
  onLoadFailed: () => events.push('loadFailed'),
  conflictTitle: (t: string) => `${t} (conflict copy)`,
}

const newEngine = () => new NoteSync(dek, server, store, hooks)
const titleOf = async (row: EncryptedNote) => (await decryptNote(dek, row.id, row.ciphertext, row.iv)).title
const settle = async (e: NoteSync) => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 5))
    await e.flush()
  }
}

/** Simulates another device editing a note directly on the server. */
async function remoteEdit(id: string, title: string) {
  const cur = server.rows.get(id)!
  const { ciphertext, iv } = await encryptNote(dek, id, { title, body: '', color: 'default', labels: [] })
  await server.putNote(id, { ciphertext, iv, pinned: cur.pinned, archived: cur.archived, trashedAt: cur.trashedAt, position: cur.position, baseVersion: cur.version })
}

async function remoteEditBody(id: string, title: string, body: string) {
  const cur = server.rows.get(id)!
  const { ciphertext, iv } = await encryptNote(dek, id, { title, body, color: 'default', labels: [] })
  await server.putNote(id, { ciphertext, iv, pinned: cur.pinned, archived: cur.archived, trashedAt: cur.trashedAt, position: cur.position, baseVersion: cur.version })
}

beforeEach(async () => {
  dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  server = new FakeServer()
  store = createLocalStore(`test-${++dbCount}`)
  events.length = 0
})

describe('offline-first sync', () => {
  it('queues edits offline, survives a reload, and syncs when back online', async () => {
    server.mode = 'offline'
    const a = newEngine()
    await a.start()
    expect(a.getSnapshot().status.online).toBe(false)

    const note = { ...emptyNote(), title: 'Written on the train' }
    a.upsert(note, { immediate: true })
    await settle(a)
    expect(a.getSnapshot().status.pending).toBe(1)
    expect(server.rows.size).toBe(0)
    a.stop()

    // App restarts, still offline: note comes from the device cache.
    const b = newEngine()
    await b.start()
    expect([...b.getSnapshot().notes.values()].map((n) => n.title)).toEqual(['Written on the train'])
    expect(b.getSnapshot().status.pending).toBe(1)
    // Nothing has reached the server yet, so there is no "last synced" time to show.
    expect(b.getSnapshot().status.lastSyncedAt).toBeNull()

    server.mode = 'up'
    const before = Date.now()
    await b.sync({ reconcile: true })
    expect(b.getSnapshot().status).toMatchObject({ online: true, pending: 0 })
    expect(b.getSnapshot().status.lastSyncedAt).toBeGreaterThanOrEqual(before)
    expect(await titleOf(server.rows.get(note.id)!)).toBe('Written on the train')
    expect(b.getSnapshot().notes.get(note.id)!.version).toBe(1)
  })

  it('rebases a second edit made while the first is in flight (no false conflict)', async () => {
    const e = newEngine()
    await e.start()
    const note = { ...emptyNote(), title: 'v1' }
    e.upsert(note, { immediate: true })
    await settle(e)

    let release!: () => void
    server.gate = new Promise((r) => (release = r))
    e.update(note.id, { title: 'v2' }, { immediate: true })
    await new Promise((r) => setTimeout(r, 20)) // v2 is now in flight
    e.update(note.id, { title: 'v3' }, { immediate: true })
    await new Promise((r) => setTimeout(r, 20)) // v3 queued on the same base
    server.gate = null
    release()
    await settle(e)

    expect(events).not.toContain('conflict')
    expect(server.rows.size).toBe(1)
    expect(await titleOf(server.rows.get(note.id)!)).toBe('v3')
    expect(server.rows.get(note.id)!.version).toBe(3)
  })

  it('keeps both versions when two devices edit the same note', async () => {
    const e = newEngine()
    await e.start()
    const note = { ...emptyNote(), title: 'Shopping' }
    e.upsert(note, { immediate: true })
    await settle(e)

    server.mode = 'offline'
    e.update(note.id, { title: 'Shopping (phone, offline)' }, { immediate: true })
    await settle(e)
    server.mode = 'up'
    await remoteEdit(note.id, 'Shopping (laptop)')

    await e.sync({ reconcile: true })
    await settle(e)

    const titles = [...e.getSnapshot().notes.values()].map((n) => n.title).sort()
    expect(titles).toEqual(['Shopping (laptop)', 'Shopping (phone, offline) (conflict copy)'])
    expect(events).toContain('conflict')
    expect(server.rows.size).toBe(2)
  })

  it('merges edits to different lines from two devices into one note', async () => {
    const e = newEngine()
    await e.start()
    const note = { ...emptyNote(), title: 'Groceries', body: '- [ ] milk\n- [ ] eggs\n- [ ] bread' }
    e.upsert(note, { immediate: true })
    await settle(e)

    // Phone (this engine) adds an item while offline…
    server.mode = 'offline'
    e.update(note.id, { body: '- [ ] milk\n- [ ] eggs\n- [ ] bread\n- [ ] coffee' }, { immediate: true })
    await settle(e)
    // …while the laptop ticks the first one.
    server.mode = 'up'
    const cur = server.rows.get(note.id)!
    const { ciphertext, iv } = await encryptNote(dek, note.id, { title: 'Groceries', body: '- [x] milk\n- [ ] eggs\n- [ ] bread', color: 'default', labels: ['home'] })
    await server.putNote(note.id, { ciphertext, iv, pinned: false, archived: false, trashedAt: null, position: cur.position, baseVersion: cur.version })

    await e.sync({ reconcile: true })
    await settle(e)

    expect(events).toEqual(['merged'])
    expect(e.getSnapshot().notes.size).toBe(1)
    const merged = e.getSnapshot().notes.get(note.id)!
    expect(merged.body).toBe('- [x] milk\n- [ ] eggs\n- [ ] bread\n- [ ] coffee')
    expect(merged.labels).toEqual(['home'])
    const onServer = server.rows.get(note.id)!
    expect((await decryptNote(dek, note.id, onServer.ciphertext, onServer.iv)).body).toBe(merged.body)
    expect(e.getSnapshot().status.pending).toBe(0)
  })

  it('merges after a restart too (the base survives in the device cache)', async () => {
    const a = newEngine()
    await a.start()
    const note = { ...emptyNote(), title: 'Plan', body: 'one\ntwo\nthree' }
    a.upsert(note, { immediate: true })
    await settle(a)
    server.mode = 'offline'
    a.update(note.id, { body: 'one\ntwo\nthree\nfour' }, { immediate: true })
    await settle(a)
    a.stop()

    server.mode = 'up'
    await remoteEditBody(note.id, 'Plan', 'zero\none\ntwo\nthree')

    const b = newEngine()
    await b.start()
    await settle(b)
    expect(b.getSnapshot().notes.get(note.id)!.body).toBe('zero\none\ntwo\nthree\nfour')
    expect(b.getSnapshot().notes.size).toBe(1)
  })

  it('removes notes deleted on another device, but re-creates one you edited meanwhile', async () => {
    const e = newEngine()
    await e.start()
    const keep = { ...emptyNote(), title: 'edited here' }
    const gone = { ...emptyNote(), title: 'deleted elsewhere' }
    e.upsert(keep, { immediate: true })
    e.upsert(gone, { immediate: true })
    await settle(e)

    server.rows.delete(keep.id)
    server.rows.delete(gone.id)
    server.mode = 'offline'
    e.update(keep.id, { body: 'more' }, { immediate: true })
    await settle(e)

    server.mode = 'up'
    await e.sync({ reconcile: true })
    await settle(e)
    expect(e.getSnapshot().notes.has(gone.id)).toBe(false)
    expect(e.getSnapshot().notes.has(keep.id)).toBe(true)
    expect(server.rows.has(keep.id)).toBe(true)
    expect(server.rows.has(gone.id)).toBe(false)
  })

  it('does not advance the sync point past another device’s change', async () => {
    const e = newEngine()
    await e.start()
    const mine = { ...emptyNote(), title: 'mine' }
    const theirs = { ...emptyNote(), title: 'theirs' }
    e.upsert(theirs, { immediate: true })
    await settle(e)
    await e.sync()

    await remoteEdit(theirs.id, 'theirs, edited on laptop') // lands before our next push
    e.upsert(mine, { immediate: true })
    await settle(e)
    await e.sync()
    expect(e.getSnapshot().notes.get(theirs.id)!.title).toBe('theirs, edited on laptop')
  })

  it('pauses on an expired session and keeps the change', async () => {
    const e = newEngine()
    await e.start()
    server.mode = 'expired'
    const note = { ...emptyNote(), title: 'after lunch' }
    e.upsert(note, { immediate: true })
    await settle(e)
    expect(e.getSnapshot().status).toMatchObject({ authExpired: true, pending: 1 })

    server.mode = 'up'
    e.retry()
    await settle(e)
    expect(e.getSnapshot().status).toMatchObject({ authExpired: false, pending: 0 })
    expect(server.rows.has(note.id)).toBe(true)
  })

  it('deletes forever offline and sends the delete later', async () => {
    const e = newEngine()
    await e.start()
    const note = { ...emptyNote(), title: 'old', trashedAt: 5 }
    e.upsert(note, { immediate: true })
    await settle(e)
    server.mode = 'offline'
    await e.destroy(note.id)
    expect(e.getSnapshot().notes.has(note.id)).toBe(false)
    expect(server.rows.has(note.id)).toBe(true)
    server.mode = 'up'
    await e.sync()
    expect(server.rows.has(note.id)).toBe(false)
    expect(e.getSnapshot().status.pending).toBe(0)
  })

  it('queues an offline import and uploads it later', async () => {
    const e = newEngine()
    await e.start()
    server.mode = 'offline'
    const parsed = ['a', 'b', 'c'].map((title) => ({
      title, body: `${title} body`, color: 'default' as const, labels: [], pinned: false, archived: false, modifiedAt: 1, sourcePath: `${title}.md`,
    }))
    const res = await e.importMany(parsed)
    expect(res).toMatchObject({ created: 0, queued: 3, duplicates: 0 })
    expect(e.getSnapshot().notes.size).toBe(3)

    server.mode = 'up'
    await e.sync()
    expect(server.rows.size).toBe(3)
    expect(e.getSnapshot().status.pending).toBe(0)
  })
})
