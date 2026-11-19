/**
 * Shared links: a read-only snapshot of one note (title and body; no labels, color or images).
 * The snapshot is encrypted here with a fresh random key; only the ciphertext is uploaded.
 * The key goes in the link's #fragment, which browsers never send to a server.
 * worker/shares.ts serves the page that decrypts it, with the same format.
 */
import type { CreateShareBody, ShareInfo } from '../../shared/types'
import { api, ApiError } from './api'

type Days = CreateShareBody['days']

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const fromB64 = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))
const aad = (id: string) => new TextEncoder().encode(`share:${id}`)

export interface SealedShare {
  /** What is sent to the server. */
  body: CreateShareBody
  /** The key, base64url; only ever in the link. */
  key: string
}

/**
 * Encrypt a snapshot of a note for a new link.
 * The id is only an address (8 random bytes); the key is a single-use AES-128-GCM key (16 random bytes).
 * Links made before v0.9 have a 16-byte id and a 32-byte key; openShare and the share page read both.
 */
export async function sealShare(note: { id: string; title: string; body: string }, days: Days): Promise<SealedShare> {
  const id = b64url(crypto.getRandomValues(new Uint8Array(8)))
  const raw = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const pt = new TextEncoder().encode(JSON.stringify({ title: note.title, body: note.body }))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(id) }, key, pt))
  return { body: { id, noteId: note.id, ciphertext: b64(ct), iv: b64(iv), days }, key: b64url(raw) }
}

/** Decrypt a shared snapshot (the share page does the same in plain JS). */
export async function openShare(id: string, key: string, ciphertext: string, iv: string): Promise<{ title: string; body: string }> {
  const k = await crypto.subtle.importKey('raw', fromB64(key), 'AES-GCM', false, ['decrypt'])
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: aad(id) }, k, fromB64(ciphertext))
  const raw = JSON.parse(new TextDecoder().decode(pt)) as { title?: unknown; body?: unknown }
  return { title: typeof raw.title === 'string' ? raw.title : '', body: typeof raw.body === 'string' ? raw.body : '' }
}

export const shareUrl = (id: string, key: string, origin = location.origin) => `${origin}/s/${id}#${key}`

/** Create a link to a note and return it with its info. */
export async function createShareLink(note: { id: string; title: string; body: string }, days: Days): Promise<{ url: string; info: ShareInfo }> {
  for (let attempt = 1; ; attempt++) {
    const sealed = await sealShare(note, days)
    try {
      const info = await api.createShare(sealed.body)
      return { url: shareUrl(sealed.body.id, sealed.key), info }
    } catch (e) {
      // The id is taken (the server never overwrites a link): seal again under a new one.
      const taken = e instanceof ApiError && e.status === 409 && (e.body as { error?: string } | null)?.error === 'conflict'
      if (!taken || attempt >= 3) throw e
    }
  }
}
