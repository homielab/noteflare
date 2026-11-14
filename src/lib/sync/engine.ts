/**
 * Offline-first note sync.
 *
 * - Notes are decrypted from the on-device cache first, so the app opens instantly
 *   and works without a connection.
 * - Every edit is encrypted and written to an outbox (persisted in IndexedDB),
 *   then pushed. If the push fails because the device is offline, the session
 *   expired or the server is down, the change waits and is retried later.
 * - The server's per-note `version` detects edits made on another device. When
 *   both sides changed a note, the server copy wins and the local edit is kept as
 *   a separate "conflict copy" — nothing is silently lost.
 *
 * Framework-free so it can be tested without React; see `useNotes` for the hook.
 */
import {
  BATCH_MAX_BYTES,
  BATCH_MAX_NOTES,
  type BatchNoteItem,
  type BatchResult,
  type EncryptedNote,
  type PutNoteBody,
} from '../../../shared/types'
import { ApiError } from '../api'
import { decryptNote, encryptNote } from '../crypto'
import { dedupeKey, type ParsedNote } from '../importMarkdown'
import { emptyNote, localRow, sameContent, toPayload, type Note, type NotePatch } from '../noteModel'
import type { LocalStore, OutboxEntry } from './localStore'
import { mergeNotes, type MergeSide } from './merge'

export interface SyncApi {
  listNotes(since: number): Promise<EncryptedNote[]>
  noteIndex(): Promise<{ id: string; version: number }[]>
  putNote(id: string, body: PutNoteBody): Promise<EncryptedNote>
  deleteNote(id: string): Promise<void>
  createNotes(notes: BatchNoteItem[]): Promise<BatchResult>
}

export interface SyncStatus {
  /** The last request reached the server. */
  online: boolean
  /** Cloudflare Access session expired; changes wait until the user signs in again. */
  authExpired: boolean
  /** A push is in progress. */
  syncing: boolean
  /** Changes not yet confirmed by the server (queued or waiting for the debounce). */
  pending: number
}

export interface Snapshot {
  notes: Map<string, Note>
  loading: boolean
  status: SyncStatus
}

export interface SyncHooks {
  /** A conflict copy was created. */
  onConflict(): void
  /** Edits from another device were merged into a note automatically. */
  onMerged(): void
  /** The server rejected a change outright (4xx); it was dropped. */
  onRejected(): void
  /** Nothing cached and the first load failed. */
  onLoadFailed(): void
  conflictTitle(title: string): string
}

export interface ImportResult {
  created: number
  /** Saved on this device, will upload when back online. */
  queued: number
  duplicates: number
  failed: number
}

const DEBOUNCE_MS = 700
/** Re-read a little before the last sync point so same-millisecond writes are never missed. */
const SINCE_OVERLAP_MS = 2000
const MAX_FLUSH_ROUNDS = 8

export class NoteSync {
  private snap: Snapshot = {
    notes: new Map(),
    loading: true,
    status: { online: true, authExpired: false, syncing: false, pending: 0 },
  }
  private listeners = new Set<() => void>()
  private outbox = new Map<string, OutboxEntry>()
  private dirty = new Set<string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Latest enqueue per note; older encryptions that finish late are discarded. */
  private tickets = new Map<string, number>()
  /** Last server-confirmed copy of each note: the base for three-way merges. */
  private synced = new Map<string, EncryptedNote>()
  private seq = 0
  private lastSync = 0
  private flushing: Promise<void> | null = null
  private rerun: Promise<void> | null = null
  private inflightId: string | null = null
  private started: Promise<void> | null = null
  private stopped = false

  constructor(
    private readonly dek: CryptoKey,
    private readonly api: SyncApi,
    private readonly store: LocalStore,
    private readonly hooks: SyncHooks,
  ) {}

  // ------------------------------------------------------------ external store

  getSnapshot = () => this.snap

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private emit(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch }
    this.listeners.forEach((fn) => fn())
  }

  private setStatus(patch: Partial<SyncStatus>) {
    const cur = this.snap.status
    if (Object.entries(patch).every(([k, v]) => cur[k as keyof SyncStatus] === v)) return
    this.emit({ status: { ...cur, ...patch } })
  }

  private setNotes(fn: (m: Map<string, Note>) => Map<string, Note>) {
    const next = fn(this.snap.notes)
    if (next !== this.snap.notes) this.emit({ notes: next })
  }

  private refreshPending() {
    this.setStatus({ pending: this.outbox.size + this.dirty.size })
  }

  // ------------------------------------------------------------ lifecycle

  /** Load the cache, then sync. Safe to call more than once. */
  start = () => {
    this.stopped = false
    return (this.started ??= this.load().then(() => this.sync({ reconcile: true })))
  }

  /** Stop timers; edits waiting for the debounce are queued right away. */
  stop = () => {
    this.stopped = true
    this.flushDirty()
  }

  private async load() {
    const [rows, entries, meta] = await Promise.all([this.store.allNotes(), this.store.allOutbox(), this.store.getMeta()])
    this.lastSync = meta?.lastSync ?? 0
    for (const e of entries) this.outbox.set(e.id, e)
    this.seq = entries.reduce((max, e) => Math.max(max, e.seq), 0)

    const notes = new Map<string, Note>()
    for (const row of rows) {
      const entry = this.outbox.get(row.id)
      if (entry?.kind === 'delete') continue
      if (!entry) this.synced.set(row.id, row) // no local edits: the cached row is the server copy
      const n = await this.decryptRow(row)
      if (!n) continue
      // A queued push carries the version it builds on (it may have been rebased).
      if (entry?.kind === 'put') n.version = entry.body.baseVersion
      notes.set(n.id, n)
    }
    this.emit({ notes, loading: notes.size === 0 })
    this.refreshPending()
  }

  /** Push queued changes, then pull what changed elsewhere. */
  sync = async (opts: { reconcile?: boolean } = {}) => {
    await this.flush()
    if (this.snap.status.authExpired) {
      this.finishLoading(false)
      return
    }
    try {
      await this.pull(opts.reconcile ?? false)
      this.setStatus({ online: true, authExpired: false })
      this.finishLoading(true)
    } catch (err) {
      this.handleError(err)
      this.finishLoading(false)
    }
  }

  /** Called on a timer: retry queued pushes, or check whether we're back online. */
  retry = () => {
    if (this.flushing) return
    if (!this.snap.status.online || this.snap.status.authExpired) void this.sync({ reconcile: true })
    else if (this.outbox.size) void this.flush()
  }

  markOffline = () => this.setStatus({ online: false })

  hasUnqueuedEdits = () => this.dirty.size > 0

  private finishLoading(ok: boolean) {
    if (!this.snap.loading) return
    if (!ok && this.snap.notes.size === 0) this.hooks.onLoadFailed()
    this.emit({ loading: false })
  }

  private handleError(err: unknown) {
    if (err instanceof ApiError) {
      if (err.status === 401) this.setStatus({ authExpired: true })
      else this.setStatus({ online: true })
    } else {
      this.setStatus({ online: false })
    }
  }

  // ------------------------------------------------------------ pull

  private async pull(reconcile: boolean) {
    const isBusy = (id: string) => this.outbox.has(id) || this.dirty.has(id)
    // Only notes the server already knew about, untouched locally, may be removed by reconciliation.
    const removable = new Set(
      [...this.snap.notes.values()].filter((n) => n.version > 0 && !isBusy(n.id)).map((n) => n.id),
    )

    const [rows, index] = await Promise.all([
      this.api.listNotes(Math.max(0, this.lastSync - SINCE_OVERLAP_MS)),
      reconcile ? this.api.noteIndex() : Promise.resolve(null),
    ])

    const newer = rows.filter((r) => !isBusy(r.id) && (this.snap.notes.get(r.id)?.version ?? 0) < r.version)
    const decoded = (await Promise.all(newer.map(async (r) => ({ r, n: await this.decryptRow(r) })))).filter(
      (d): d is { r: EncryptedNote; n: Note } => !!d.n,
    )

    // Deleted forever on another device, or purged from the trash by the server.
    let removed: string[] = []
    if (index) {
      const live = new Set(index.map((x) => x.id))
      removed = [...removable].filter((id) => !live.has(id) && !isBusy(id))
    }

    if (decoded.length || removed.length) {
      this.setNotes((m) => {
        const next = new Map(m)
        for (const { n } of decoded) {
          if (isBusy(n.id)) continue
          const cur = next.get(n.id)
          if (!cur || cur.version < n.version) next.set(n.id, n)
        }
        for (const id of removed) next.delete(id)
        return next
      })
    }
    for (const { r } of decoded) if (!isBusy(r.id)) this.synced.set(r.id, r)
    for (const id of removed) this.synced.delete(id)
    await Promise.all([this.store.putNotes(decoded.map((d) => d.r)), this.store.deleteNotes(removed)])

    if (rows.length) {
      // Advance only from pulled rows. Advancing from our own pushes could skip
      // another device's change that landed between the last pull and our push.
      this.lastSync = Math.max(this.lastSync, ...rows.map((r) => r.updatedAt))
      await this.store.setMeta({ lastSync: this.lastSync })
    }
  }

  // ------------------------------------------------------------ edits

  upsert = (note: Note, opts: { immediate?: boolean } = {}) => {
    const cur = this.snap.notes.get(note.id)
    // The engine owns version/createdAt; never take them from a stale editor copy.
    const next: Note = {
      ...note,
      version: cur?.version ?? note.version,
      createdAt: cur?.createdAt ?? note.createdAt,
      updatedAt: Date.now(),
    }
    this.setNotes((m) => new Map(m).set(note.id, next))
    this.schedule(note.id, opts.immediate)
  }

  update = (id: string, patch: NotePatch, opts: { immediate?: boolean } = {}) => {
    const cur = this.snap.notes.get(id)
    if (cur) this.upsert({ ...cur, ...patch }, opts)
  }

  /** Queue edits waiting for the debounce right away (one note, or all). */
  flushDirty = (id?: string) => {
    const ids = id ? (this.dirty.has(id) ? [id] : []) : [...this.dirty]
    for (const x of ids) void this.enqueue(x)
  }

  /** Drop a draft that was never saved. */
  discard = (id: string) => {
    const cur = this.snap.notes.get(id)
    if (!cur || cur.version !== 0) return
    this.clearLocalWork(id)
    this.synced.delete(id)
    this.setNotes((m) => without(m, id))
    if (this.outbox.has(id) && this.inflightId !== id) void this.removeEntry(id)
    void this.store.deleteNotes([id])
    this.refreshPending()
  }

  /** Delete forever (used from the trash). Works offline; the delete is queued. */
  destroy = async (id: string) => {
    const note = this.snap.notes.get(id)
    this.clearLocalWork(id)
    this.synced.delete(id)
    this.setNotes((m) => without(m, id))
    await this.store.deleteNotes([id])

    // Never reached the server and isn't being sent right now: nothing to delete remotely.
    if (note?.version === 0 && this.inflightId !== id) {
      await this.removeEntry(id)
      this.refreshPending()
      return
    }
    const entry: OutboxEntry = { id, kind: 'delete', seq: ++this.seq }
    this.outbox.set(id, entry)
    this.refreshPending()
    await this.store.putOutbox(entry)
    void this.flush()
  }

  private schedule(id: string, immediate = false) {
    this.dirty.add(id)
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    if (immediate || this.stopped) void this.enqueue(id)
    else this.timers.set(id, setTimeout(() => void this.enqueue(id), DEBOUNCE_MS))
    this.refreshPending()
  }

  private clearLocalWork(id: string) {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    this.dirty.delete(id)
    this.tickets.set(id, (this.tickets.get(id) ?? 0) + 1)
  }

  private async enqueue(id: string) {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    const ticket = (this.tickets.get(id) ?? 0) + 1
    this.tickets.set(id, ticket)

    const snapshot = this.snap.notes.get(id)
    if (!snapshot) {
      this.dirty.delete(id)
      this.refreshPending()
      return
    }
    const { ciphertext, iv } = await encryptNote(this.dek, id, toPayload(snapshot))
    if (this.tickets.get(id) !== ticket) return // a newer enqueue (or a delete) superseded this one

    // Read the version only now, right before queuing: a push that finished
    // during encryption is then already reflected. The other ordering is
    // handled by rebasing in onPushed.
    const latest = this.snap.notes.get(id)
    if (!latest) return
    if (!this.timers.has(id)) this.dirty.delete(id)

    // Remember what this edit is based on, so a later conflict can be merged.
    const prev = this.outbox.get(id)
    const known = prev?.kind === 'put' ? prev.base : this.synced.get(id)
    const base = known && known.version === latest.version ? known : undefined

    const entry: OutboxEntry = {
      id,
      kind: 'put',
      seq: ++this.seq,
      base,
      body: {
        ciphertext,
        iv,
        pinned: snapshot.pinned,
        archived: snapshot.archived,
        trashedAt: snapshot.trashedAt,
        position: snapshot.position,
        baseVersion: latest.version,
      },
    }
    this.outbox.set(id, entry)
    this.refreshPending()
    await Promise.all([
      this.store.putOutbox(entry),
      this.store.putNotes([localRow({ ...snapshot, version: latest.version }, ciphertext, iv)]),
    ])
    void this.flush()
  }

  // ------------------------------------------------------------ push

  /**
   * Push the outbox. If a push is already running, one more run is scheduled
   * right after it, so callers always get a pass that saw their change.
   */
  flush = (): Promise<void> => {
    if (!this.flushing) return this.startFlush()
    this.rerun ??= this.flushing.then(() => {
      this.rerun = null
      return this.flush()
    })
    return this.rerun
  }

  private startFlush() {
    // Clear the flag from a separate continuation: with an empty outbox the run
    // finishes synchronously, before `this.flushing` would even be assigned.
    const run = this.runFlush()
    this.flushing = run
    void run.finally(() => {
      if (this.flushing === run) this.flushing = null
    })
    return run
  }

  private async runFlush() {
    if (this.outbox.size) this.setStatus({ syncing: true })
    try {
      for (let round = 0; round < MAX_FLUSH_ROUNDS; round++) {
        const entries = [...this.outbox.values()].sort((a, b) => a.seq - b.seq)
        if (!entries.length) break
        let keepGoing = true
        for (const e of entries) {
          if (this.outbox.get(e.id) !== e) continue // replaced meanwhile; the next round sends the new one
          keepGoing = await this.send(e)
          if (!keepGoing) break
        }
        if (!keepGoing) break
      }
    } finally {
      this.setStatus({ syncing: false })
      this.refreshPending()
    }
  }

  /** Returns false when sending should stop for now (offline, signed out, server down). */
  private async send(e: OutboxEntry): Promise<boolean> {
    this.inflightId = e.id
    try {
      if (e.kind === 'put') {
        const saved = await this.api.putNote(e.id, e.body)
        await this.onPushed(e, saved)
      } else {
        try {
          await this.api.deleteNote(e.id)
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err // already gone is fine
        }
        await this.removeEntry(e.id, e)
      }
      this.setStatus({ online: true, authExpired: false })
      return true
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409 && e.kind === 'put') {
          await this.resolveConflict(e, (err.body as { current?: EncryptedNote } | null)?.current)
          this.setStatus({ online: true, authExpired: false })
          return true
        }
        if (err.status === 404 && e.kind === 'put') {
          await this.recreate(e) // deleted forever elsewhere: the local edit wins and the note comes back
          return true
        }
        if (err.status === 401) {
          this.setStatus({ authExpired: true })
          return false
        }
        if (err.status >= 500 || err.status === 429) {
          this.setStatus({ online: true })
          return false
        }
        await this.removeEntry(e.id, e)
        this.hooks.onRejected()
        return true
      }
      // fetch reports network failures as TypeError; anything else is a bug worth seeing.
      if (!(err instanceof TypeError)) console.error('Sync failed', err)
      this.setStatus({ online: false })
      return false
    } finally {
      this.inflightId = null
    }
  }

  private async onPushed(sent: Extract<OutboxEntry, { kind: 'put' }>, saved: EncryptedNote) {
    const cur = this.outbox.get(sent.id)
    this.synced.set(sent.id, saved)
    if (cur === sent) {
      this.outbox.delete(sent.id)
      await Promise.all([this.store.deleteOutbox(sent.id), this.store.putNotes([saved])])
    } else if (cur?.kind === 'put' && cur.body.baseVersion === sent.body.baseVersion) {
      // A newer edit was queued while this one was in flight, built on the same
      // version. We created the new server version ourselves, so rebase onto it.
      const rebased: OutboxEntry = { ...cur, base: saved, body: { ...cur.body, baseVersion: saved.version } }
      this.outbox.set(sent.id, rebased)
      await this.store.putOutbox(rebased)
    }
    this.setNotes((m) => {
      const n = m.get(sent.id)
      if (!n) return m
      return new Map(m).set(sent.id, { ...n, version: saved.version, createdAt: saved.createdAt })
    })
  }

  private async recreate(sent: Extract<OutboxEntry, { kind: 'put' }>) {
    const cur = this.outbox.get(sent.id)
    if (cur?.kind !== 'put') return
    this.synced.delete(sent.id)
    const reborn: OutboxEntry = { ...cur, base: undefined, body: { ...cur.body, baseVersion: 0 } }
    this.outbox.set(sent.id, reborn)
    await this.store.putOutbox(reborn)
    this.setNotes((m) => {
      const n = m.get(sent.id)
      return n ? new Map(m).set(sent.id, { ...n, version: 0 }) : m
    })
  }

  private async resolveConflict(sent: Extract<OutboxEntry, { kind: 'put' }>, current?: EncryptedNote) {
    const local = this.snap.notes.get(sent.id)
    const server = current ? await this.decryptRow(current) : null
    if (!server) {
      // Can't read the server copy (shouldn't happen): keep ours, rebased on whatever exists.
      await this.removeEntry(sent.id)
      return
    }

    // The merge or conflict copy below captures the newest local content, so all pending work for this id goes.
    this.clearLocalWork(sent.id)
    await this.removeEntry(sent.id)
    this.synced.set(sent.id, current!)
    await this.store.putNotes([current!])

    // Both devices changed the note: try a three-way merge from the version both started at.
    const base = sent.base ? await this.decryptRow(sent.base) : null
    const merged = local && base ? mergeNotes(sideOf(base), sideOf(local), sideOf(server)) : null
    if (local && merged) {
      const note: Note = { ...server, ...merged }
      this.setNotes((m) => new Map(m).set(note.id, note))
      if (!sameContent(note, server)) {
        this.schedule(note.id, true)
        this.hooks.onMerged()
      }
      return
    }

    // Couldn't merge (same lines changed differently): the server copy stays, ours becomes a copy.
    this.setNotes((m) => new Map(m).set(server.id, server))
    if (!local || sameContent(local, server)) return
    const copy: Note = {
      ...emptyNote(),
      ...toPayload(local),
      pinned: local.pinned,
      archived: local.archived,
      trashedAt: local.trashedAt,
      position: local.position,
      title: this.hooks.conflictTitle(local.title),
    }
    this.setNotes((m) => new Map(m).set(copy.id, copy))
    this.schedule(copy.id, true)
    this.hooks.onConflict()
  }

  /** Remove the outbox entry for `id` (only if it is still `expected`, when given). */
  private async removeEntry(id: string, expected?: OutboxEntry) {
    const cur = this.outbox.get(id)
    if (!cur || (expected && cur !== expected)) return
    this.outbox.delete(id)
    await this.store.deleteOutbox(id)
  }

  // ------------------------------------------------------------ import

  /**
   * Import many notes: skip duplicates, encrypt locally, show them right away,
   * upload in batches. Batches that can't be sent are queued for later.
   */
  importMany = async (parsed: ParsedNote[], onProgress?: (done: number, total: number) => void): Promise<ImportResult> => {
    const seen = new Set([...this.snap.notes.values()].filter((n) => !n.trashedAt).map(dedupeKey))
    const fresh = parsed.filter((p) => {
      const key = dedupeKey(p)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const result: ImportResult = { created: 0, queued: 0, duplicates: parsed.length - fresh.length, failed: 0 }
    if (!fresh.length) return result

    const prepared = await Promise.all(
      fresh.map(async (p) => {
        const note: Note = {
          ...emptyNote(),
          title: p.title,
          body: p.body,
          color: p.color,
          labels: p.labels,
          pinned: p.pinned && !p.archived,
          archived: p.archived,
          position: p.modifiedAt,
        }
        const { ciphertext, iv } = await encryptNote(this.dek, note.id, toPayload(note))
        return { note, row: localRow(note, ciphertext, iv) }
      }),
    )

    // Visible and cached immediately, before any upload.
    this.setNotes((m) => {
      const next = new Map(m)
      for (const { note } of prepared) next.set(note.id, note)
      return next
    })
    await this.store.putNotes(prepared.map((p) => p.row))

    const chunks = chunk(prepared, (p) => p.row.ciphertext.length + 200)
    let reachable = true
    onProgress?.(0, prepared.length)
    for (const part of chunks) {
      if (reachable) {
        try {
          const res = await this.api.createNotes(part.map(({ row }) => toBatchItem(row)))
          const created = new Map(res.created.map((c) => [c.id, c]))
          this.setNotes((m) => {
            const next = new Map(m)
            for (const c of res.created) {
              const n = next.get(c.id)
              if (n) next.set(c.id, { ...n, version: c.version, createdAt: c.createdAt })
            }
            return next
          })
          const confirmed = part.filter(({ row }) => created.has(row.id)).map(({ row }) => ({ ...row, ...created.get(row.id)! }))
          for (const row of confirmed) this.synced.set(row.id, row)
          await this.store.putNotes(confirmed)
          result.created += res.created.length
          result.failed += res.skipped.length
          this.setStatus({ online: true, authExpired: false })
          onProgress?.(result.created + result.queued + result.failed, prepared.length)
          continue
        } catch (err) {
          const transient = !(err instanceof ApiError) || err.status === 401 || err.status >= 500 || err.status === 429
          if (!transient) {
            result.failed += part.length
            this.setNotes((m) => {
              const next = new Map(m)
              for (const { note } of part) next.delete(note.id)
              return next
            })
            await this.store.deleteNotes(part.map(({ note }) => note.id))
            continue
          }
          this.handleError(err)
          reachable = false
        }
      }
      // Offline / signed out / server down: queue each note for a later push.
      for (const { row } of part) {
        const entry: OutboxEntry = { id: row.id, kind: 'put', seq: ++this.seq, body: { ...toBatchItem(row), baseVersion: 0 } }
        this.outbox.set(row.id, entry)
        await this.store.putOutbox(entry)
      }
      result.queued += part.length
      onProgress?.(result.created + result.queued + result.failed, prepared.length)
    }
    this.refreshPending()
    return result
  }

  // ------------------------------------------------------------ helpers

  private async decryptRow(row: EncryptedNote): Promise<Note | null> {
    try {
      const payload = await decryptNote(this.dek, row.id, row.ciphertext, row.iv)
      const { ciphertext: _c, iv: _i, ...meta } = row
      return { ...meta, ...payload }
    } catch {
      console.warn('Could not decrypt note', row.id)
      return null
    }
  }
}

function sideOf(n: Note): MergeSide {
  return {
    title: n.title,
    body: n.body,
    color: n.color,
    labels: n.labels,
    pinned: n.pinned,
    archived: n.archived,
    trashedAt: n.trashedAt,
    position: n.position,
  }
}

function without<K, V>(m: Map<K, V>, key: K) {
  if (!m.has(key)) return m
  const next = new Map(m)
  next.delete(key)
  return next
}

function toBatchItem(row: EncryptedNote): BatchNoteItem {
  return {
    id: row.id,
    ciphertext: row.ciphertext,
    iv: row.iv,
    pinned: row.pinned,
    archived: row.archived,
    trashedAt: row.trashedAt,
    position: row.position,
  }
}

/** Split into batches by count and approximate request size. */
function chunk<T>(items: T[], size: (item: T) => number): T[][] {
  const out: T[][] = []
  let cur: T[] = []
  let bytes = 0
  for (const item of items) {
    const b = size(item)
    if (cur.length && (cur.length >= BATCH_MAX_NOTES || bytes + b > BATCH_MAX_BYTES * 0.9)) {
      out.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(item)
    bytes += b
  }
  if (cur.length) out.push(cur)
  return out
}
