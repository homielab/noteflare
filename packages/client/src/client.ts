/**
 * NoteFlareClient — talk to a NoteFlare server from Node, Deno, Bun, browsers
 * and extensions. Notes are encrypted and decrypted here, on the client: the
 * token only lets you fetch ciphertext, and `unlock()` with the user's
 * passphrase is what makes it readable.
 */
import {
  decryptNote,
  encryptNote,
  NOTE_COLORS,
  unlockWithPassphrase,
  unlockWithRecovery,
  type NoteColor,
  type NotePayload,
} from './crypto.js'
import { mergeNotes, type MergeSide } from './merge.js'
import type { EncryptedNote, MeResponse, PutNoteBody, VaultRecord } from './protocol.js'

export interface ClientOptions {
  /** Your NoteFlare URL, e.g. "https://notes.example.com". */
  url: string
  /** A personal access token (nf_…) from Account → Integrations. */
  token: string
  /** Extra headers on every request, e.g. a Cloudflare Access service token. */
  headers?: Record<string, string>
  /** Custom fetch (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch
}

/** A decrypted note. */
export interface Note extends NotePayload {
  id: string
  pinned: boolean
  archived: boolean
  /** ms since epoch, or null when not in the trash. */
  trashedAt: number | null
  position: number
  version: number
  createdAt: number
  updatedAt: number
}

/** Fields you can set when creating or editing a note. */
export interface NoteInput {
  title?: string
  body?: string
  color?: NoteColor
  labels?: string[]
  pinned?: boolean
  archived?: boolean
  position?: number
}

export interface ListOptions {
  /** Include archived notes (default false). */
  archived?: boolean
  /** Include notes in the trash (default false). */
  trashed?: boolean
  /** Only notes with this label. */
  label?: string
}

export class NoteFlareError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly body?: unknown,
  ) {
    super(message ?? `NoteFlare API error ${status} (${code})`)
    this.name = 'NoteFlareError'
  }
}

/** Thrown by `save()` when another device changed the same lines differently. */
export class ConflictError extends NoteFlareError {
  constructor(
    public readonly mine: Note,
    public readonly theirs: Note,
  ) {
    super(409, 'conflict', `"${mine.title || mine.id}" was changed elsewhere in a way that can't be merged automatically`)
    this.name = 'ConflictError'
  }
}

const MAX_ATTEMPTS = 4
/** Recent server versions remembered per note, so a stale edit can still find its common ancestor. */
const VERSIONS_KEPT = 8

export class NoteFlareClient {
  private readonly base: string
  private readonly doFetch: typeof fetch
  private key: CryptoKey | null = null
  /** Recent server copies of each note, by version: common ancestors for three-way merges. */
  private readonly seen = new Map<string, Map<number, Note>>()

  constructor(private readonly opts: ClientOptions) {
    this.base = opts.url.replace(/\/+$/, '') + '/api/v1'
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  // ------------------------------------------------------------ session

  /** Who the token belongs to, and whether it can write. */
  me(): Promise<MeResponse> {
    return this.request('GET', '/me')
  }

  /** Derive the key from the passphrase (Argon2id; takes ~0.5–2 s) and keep it in memory. */
  async unlock(passphrase: string): Promise<void> {
    const vault = await this.request<VaultRecord>('GET', '/vault')
    this.key = await unlockWithPassphrase(vault, passphrase)
  }

  /** Unlock with the recovery code instead of the passphrase. */
  async unlockWithRecoveryCode(code: string): Promise<void> {
    const vault = await this.request<VaultRecord>('GET', '/vault')
    this.key = await unlockWithRecovery(vault, code)
  }

  /** Forget the key. */
  lock(): void {
    this.key = null
    this.seen.clear()
  }

  get unlocked(): boolean {
    return this.key !== null
  }

  // ------------------------------------------------------------ reading

  /** All notes, newest position first. Archived and trashed notes are left out unless asked for. */
  async list(opts: ListOptions = {}): Promise<Note[]> {
    const rows = await this.request<EncryptedNote[]>('GET', '/notes?since=0')
    const notes = await Promise.all(rows.map((r) => this.decrypt(r)))
    return notes
      .filter((n) => (opts.trashed ? true : !n.trashedAt))
      .filter((n) => (opts.archived || n.trashedAt ? true : !n.archived))
      .filter((n) => (opts.label ? n.labels.includes(opts.label) : true))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.position - a.position)
  }

  async get(id: string): Promise<Note> {
    return this.decrypt(await this.request<EncryptedNote>('GET', `/notes/${id}`))
  }

  /**
   * Incremental sync: notes changed after `cursor` (pass 0 the first time) and the
   * cursor to use next. Use `ids()` now and then to notice notes deleted elsewhere.
   */
  async changes(cursor = 0): Promise<{ notes: Note[]; cursor: number }> {
    const rows = await this.request<EncryptedNote[]>('GET', `/notes?since=${cursor}`)
    const notes = await Promise.all(rows.map((r) => this.decrypt(r)))
    return { notes, cursor: rows.reduce((max, r) => Math.max(max, r.updatedAt), cursor) }
  }

  /** Ids and versions of every note that exists on the server. */
  ids(): Promise<{ id: string; version: number }[]> {
    return this.request('GET', '/notes/index')
  }

  // ------------------------------------------------------------ writing

  async create(input: NoteInput): Promise<Note> {
    const now = Date.now()
    const note: Note = {
      id: crypto.randomUUID(),
      title: input.title ?? '',
      body: input.body ?? '',
      color: input.color ?? 'default',
      labels: input.labels ?? [],
      pinned: input.pinned ?? false,
      archived: input.archived ?? false,
      trashedAt: null,
      position: input.position ?? now,
      version: 0,
      createdAt: now,
      updatedAt: now,
    }
    validate(note)
    return this.push(note, 0)
  }

  /**
   * Change a note. `change` is a patch, or a function that receives the latest
   * copy and returns a patch. If someone else edits the note at the same moment,
   * the latest copy is fetched and your change is applied again — so a function
   * like `n => ({ body: n.body + '\n- [ ] milk' })` never loses anyone's edit.
   */
  async update(id: string, change: NoteInput | ((note: Note) => NoteInput)): Promise<Note> {
    for (let attempt = 1; ; attempt++) {
      const current = await this.get(id)
      const patch = typeof change === 'function' ? change(current) : change
      const next = { ...current, ...definedOnly(patch) }
      validate(next)
      try {
        return await this.push(next, current.version)
      } catch (err) {
        if (!(err instanceof NoteFlareError && err.status === 409) || attempt >= MAX_ATTEMPTS) throw err
      }
    }
  }

  /** Add lines to the end of a note's body. */
  append(id: string, text: string): Promise<Note> {
    return this.update(id, (n) => ({ body: n.body.trim() ? `${n.body.replace(/\s+$/, '')}\n${text}` : text }))
  }

  /**
   * Save a whole note you edited, e.g. in an editor, possibly while offline.
   * If the server copy changed since you fetched it, both edits are merged line
   * by line (like `git merge`). Throws ConflictError when the same lines were
   * changed differently; `err.mine` and `err.theirs` hold both versions.
   */
  async save(note: Note): Promise<Note> {
    validate(note)
    let mine = note
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.push(mine, mine.version)
      } catch (err) {
        if (!(err instanceof NoteFlareError && err.status === 409) || attempt >= MAX_ATTEMPTS) throw err
        // The version this edit started from must be looked up before decrypting
        // theirs, which records a newer version.
        const base = this.seen.get(note.id)?.get(mine.version)
        const theirs = await this.decrypt((err.body as { current: EncryptedNote }).current)
        const merged = base ? mergeNotes(side(base), side(mine), side(theirs)) : null
        if (!merged) throw new ConflictError(mine, theirs)
        mine = { ...theirs, ...merged } // now based on theirs; retry on top of it
      }
    }
  }

  /** Move to the trash (also unpins). The server deletes it for good after 30 days. */
  trash(id: string): Promise<Note> {
    return this.setTrashed(id, Date.now())
  }

  restore(id: string): Promise<Note> {
    return this.setTrashed(id, null)
  }

  archive(id: string, archived = true): Promise<Note> {
    return this.update(id, { archived, ...(archived ? { pinned: false } : {}) })
  }

  /** Delete forever. The note must be in the trash first (see `trash`). */
  async deleteForever(id: string): Promise<void> {
    await this.request('DELETE', `/notes/${id}`)
    this.seen.delete(id)
  }

  // ------------------------------------------------------------ internals

  private async setTrashed(id: string, trashedAt: number | null): Promise<Note> {
    for (let attempt = 1; ; attempt++) {
      const current = await this.get(id)
      try {
        return await this.push({ ...current, trashedAt, pinned: trashedAt ? false : current.pinned }, current.version)
      } catch (err) {
        if (!(err instanceof NoteFlareError && err.status === 409) || attempt >= MAX_ATTEMPTS) throw err
      }
    }
  }

  private async push(note: Note, baseVersion: number): Promise<Note> {
    const key = this.requireKey()
    const { ciphertext, iv } = await encryptNote(key, note.id, {
      title: note.title,
      body: note.body,
      color: note.color,
      labels: note.labels,
    })
    const body: PutNoteBody = {
      ciphertext,
      iv,
      pinned: note.pinned,
      archived: note.archived,
      trashedAt: note.trashedAt,
      position: note.position,
      baseVersion,
    }
    const saved = await this.request<EncryptedNote>('PUT', `/notes/${note.id}`, body)
    const result: Note = { ...note, version: saved.version, createdAt: saved.createdAt, updatedAt: saved.updatedAt }
    this.remember(result)
    return result
  }

  private async decrypt(row: EncryptedNote): Promise<Note> {
    const payload = await decryptNote(this.requireKey(), row.id, row.ciphertext, row.iv)
    const { ciphertext: _c, iv: _i, ...meta } = row
    const note: Note = { ...meta, ...payload }
    this.remember(note)
    return note
  }

  private remember(note: Note) {
    let versions = this.seen.get(note.id)
    if (!versions) this.seen.set(note.id, (versions = new Map()))
    versions.set(note.version, note)
    if (versions.size > VERSIONS_KEPT) versions.delete(Math.min(...versions.keys()))
  }

  private requireKey(): CryptoKey {
    if (!this.key) throw new NoteFlareError(0, 'locked', 'Call unlock(passphrase) before reading or writing notes')
    return this.key
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...this.opts.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    })
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new NoteFlareError(
        res.status,
        'access_redirect',
        'Cloudflare Access redirected the request to a login page. Allow /api/v1 for API clients (see docs/API.md).',
      )
    }
    if (res.status === 204) return undefined as T
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string; message?: string }
      throw new NoteFlareError(res.status, e.error ?? 'http_error', e.message, data)
    }
    return data as T
  }
}

function definedOnly(patch: NoteInput): NoteInput {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as NoteInput
}

function validate(n: Note) {
  if (!NOTE_COLORS.includes(n.color)) throw new TypeError(`Unknown color "${n.color}". Use one of: ${NOTE_COLORS.join(', ')}`)
  if (!Array.isArray(n.labels) || n.labels.some((l) => typeof l !== 'string')) throw new TypeError('labels must be strings')
}

function side(n: Note): MergeSide {
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
