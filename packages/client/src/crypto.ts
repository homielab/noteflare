/**
 * End-to-end encryption for notes. Everything here runs in the browser;
 * the server only receives ciphertext and wrapped keys.
 *
 *   passphrase ──Argon2id──► KEK ─┐
 *                                 ├─ AES-GCM wrap ─► wrappedDek  (in D1)
 *   recovery code ──HKDF──► RKEK ─┤                  recoveryDek (in D1)
 *   passkey PRF ────HKDF──► PKEK ─┘                  passkeys.wrappedDek (in D1, one per passkey)
 *
 *   DEK (random AES-256-GCM) ──► encrypts each note, AAD = "note:<id>"
 *                            ──► encrypts each attachment, AAD = "blob:<id>"
 */
// hash-wasm (Argon2id) is loaded on first use, so it isn't part of an app's first download.
let argon2: Promise<typeof import('hash-wasm')['argon2id']> | null = null
/** Start loading the key-derivation code early, e.g. while the passphrase is being typed. */
export const preloadKdf = () => (argon2 ??= import('hash-wasm').then((m) => m.argon2id))
import { ATTACHMENT_TYPES, type KdfParams, type VaultRecord } from './protocol.js'

const DEK_AAD = enc('noteflare:dek:v1')
const IV_BYTES = 12

/** Default Argon2id parameters (OWASP: m ≥ 19 MiB, t ≥ 2). */
export const DEFAULT_KDF = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 } as const
/** Minimum accepted from the server, to prevent downgrade attacks. */
const MIN_KDF = { memoryKiB: 19 * 1024, iterations: 2 } as const
/** Maximum accepted, so a broken or hostile record can't freeze or crash the device. */
const MAX_KDF = { memoryKiB: 256 * 1024, iterations: 16, parallelism: 4 } as const

export interface NotePayload {
  title: string
  body: string
  color: NoteColor
  labels: string[]
  /** When to remind (ms since epoch); absent = no reminder. */
  reminder?: number
  /** Original creation date (ms) of a note imported from another app. */
  importedCreatedAt?: number
  /** Original last-edit date (ms) of an imported note; dropped on its first edit here. */
  importedUpdatedAt?: number
}

export const NOTE_COLORS = ['default', 'sand', 'sage', 'sky', 'lilac', 'rose', 'clay', 'slate'] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

// ---------------------------------------------------------------- vault

export interface CreatedVault {
  record: VaultRecord
  dek: CryptoKey
  recoveryCode: string
}

export async function createVault(passphrase: string): Promise<CreatedVault> {
  const salt = randomBytes(16)
  const kdf: KdfParams = { name: 'argon2id', salt: toB64(salt), ...DEFAULT_KDF }
  const kek = await deriveKek(passphrase, kdf)

  const recoveryCode = generateRecoveryCode()
  const rkek = await deriveRecoveryKek(recoveryCode)

  const extractableDek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
  const record: VaultRecord = {
    kdf,
    wrappedDek: await wrap(extractableDek, kek),
    recoveryDek: await wrap(extractableDek, rkek),
    version: 0,
  }
  // The session uses a non-extractable copy: JS can't read the key bytes back.
  const dek = await unwrap(record.wrappedDek, kek, false)
  return { record, dek, recoveryCode }
}

export class WrongSecretError extends Error {
  constructor() {
    super('Wrong passphrase or recovery code')
  }
}

export class UnsafeKdfError extends Error {
  constructor() {
    super('Unsafe KDF parameters from server — refusing to unlock')
  }
}

export async function unlockWithPassphrase(record: VaultRecord, passphrase: string, extractable = false) {
  assertKdf(record.kdf)
  const kek = await deriveKek(passphrase, record.kdf)
  return unwrap(record.wrappedDek, kek, extractable)
}

export async function unlockWithRecovery(record: VaultRecord, code: string, extractable = false) {
  const rkek = await deriveRecoveryKek(code)
  return unwrap(record.recoveryDek, rkek, extractable)
}

/**
 * Change passphrase: unwrap the DEK (extractable, only inside this function) with
 * the old passphrase or the recovery code, then wrap it with the new passphrase.
 * No note is re-encrypted. The recovery code stays the same.
 */
export async function rewrapVault(
  record: VaultRecord,
  secret: { passphrase: string } | { recoveryCode: string },
  newPassphrase: string,
): Promise<{ record: VaultRecord; dek: CryptoKey }> {
  const dek =
    'passphrase' in secret
      ? await unlockWithPassphrase(record, secret.passphrase, true)
      : await unlockWithRecovery(record, secret.recoveryCode, true)

  const kdf: KdfParams = { name: 'argon2id', salt: toB64(randomBytes(16)), ...DEFAULT_KDF }
  const kek = await deriveKek(newPassphrase, kdf)
  const next: VaultRecord = { ...record, kdf, wrappedDek: await wrap(dek, kek) }
  return { record: next, dek: await unwrap(next.wrappedDek, kek, false) }
}

// ---------------------------------------------------------------- passkeys

/** Random PRF input for a new passkey (stored with it, not secret). */
export const newPasskeySalt = () => toB64(randomBytes(32))

/**
 * Wrap the data key for a passkey. `dek` must be extractable (from unlockWithPassphrase
 * with `extractable = true`); `prfOutput` is the passkey's PRF result for its salt.
 */
export async function wrapDekForPasskey(dek: CryptoKey, prfOutput: BufferSource, credentialId: string): Promise<string> {
  return wrap(dek, await derivePasskeyKek(prfOutput, credentialId))
}

/** Unwrap the data key with a passkey's PRF output. Wrong output → WrongSecretError. */
export async function unlockWithPasskey(wrappedDek: string, prfOutput: BufferSource, credentialId: string, extractable = false) {
  return unwrap(wrappedDek, await derivePasskeyKek(prfOutput, credentialId), extractable)
}

async function derivePasskeyKek(prfOutput: BufferSource, credentialId: string): Promise<CryptoKey> {
  if (prfOutput.byteLength < 32) throw new WrongSecretError()
  const ikm = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc('noteflare:passkey:v1'), info: enc(credentialId) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

// ---------------------------------------------------------------- notes

export async function encryptNote(dek: CryptoKey, id: string, payload: NotePayload) {
  const iv = randomBytes(IV_BYTES)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc(`note:${id}`) },
    dek,
    enc(JSON.stringify(payload)),
  )
  return { ciphertext: toB64(new Uint8Array(ct)), iv: toB64(iv) }
}

export async function decryptNote(
  dek: CryptoKey,
  id: string,
  ciphertext: string,
  iv: string,
): Promise<NotePayload> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(iv), additionalData: enc(`note:${id}`) },
    dek,
    fromB64(ciphertext),
  )
  const raw = JSON.parse(new TextDecoder().decode(pt)) as Partial<NotePayload>
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    color: NOTE_COLORS.includes(raw.color as NoteColor) ? (raw.color as NoteColor) : 'default',
    labels: Array.isArray(raw.labels) ? raw.labels.filter((l) => typeof l === 'string') : [],
    ...dateField('reminder', raw.reminder),
    ...dateField('importedCreatedAt', raw.importedCreatedAt),
    ...dateField('importedUpdatedAt', raw.importedUpdatedAt),
  }
}

/** Plaintext of a note: the optional import dates only when set. */
export function notePayload(n: NotePayload): NotePayload {
  return {
    title: n.title,
    body: n.body,
    color: n.color,
    labels: n.labels,
    ...dateField('reminder', n.reminder),
    ...dateField('importedCreatedAt', n.importedCreatedAt),
    ...dateField('importedUpdatedAt', n.importedUpdatedAt),
  }
}

/** The dates to show for a note: the original ones for an imported note. */
export function noteDates(n: NotePayload & { createdAt: number; updatedAt: number }): { createdAt: number; updatedAt: number } {
  return { createdAt: n.importedCreatedAt ?? n.createdAt, updatedAt: n.importedUpdatedAt ?? n.updatedAt }
}

function dateField<K extends string>(key: K, v: unknown): { [P in K]?: number } {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? ({ [key]: v } as { [P in K]?: number }) : {}
}

// ---------------------------------------------------------------- internals

async function deriveKek(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
  const argon2id = await preloadKdf()
  const raw = await argon2id({
    password: passphrase.normalize('NFKC'),
    salt: fromB64(kdf.salt),
    memorySize: kdf.memoryKiB,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
    hashLength: 32,
    outputType: 'binary',
  })
  return crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, [
    'wrapKey',
    'unwrapKey',
  ])
}

async function deriveRecoveryKek(code: string): Promise<CryptoKey> {
  const normalized = normalizeRecoveryCode(code)
  const ikm = await crypto.subtle.importKey('raw', enc(normalized), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc('noteflare:recovery:v1'), info: new Uint8Array() },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

async function wrap(key: CryptoKey, kek: CryptoKey): Promise<string> {
  const iv = randomBytes(IV_BYTES)
  const ct = await crypto.subtle.wrapKey('raw', key, kek, { name: 'AES-GCM', iv, additionalData: DEK_AAD })
  return toB64(concat(iv, new Uint8Array(ct)))
}

async function unwrap(wrapped: string, kek: CryptoKey, extractable: boolean): Promise<CryptoKey> {
  const bytes = fromB64(wrapped)
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      bytes.slice(IV_BYTES),
      kek,
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: DEK_AAD },
      { name: 'AES-GCM', length: 256 },
      extractable,
      ['encrypt', 'decrypt'],
    )
  } catch {
    throw new WrongSecretError()
  }
}

function assertKdf(kdf: KdfParams) {
  if (
    kdf.name !== 'argon2id' ||
    !Number.isInteger(kdf.memoryKiB) ||
    !Number.isInteger(kdf.iterations) ||
    !Number.isInteger(kdf.parallelism) ||
    kdf.memoryKiB < MIN_KDF.memoryKiB ||
    kdf.memoryKiB > MAX_KDF.memoryKiB ||
    kdf.iterations < MIN_KDF.iterations ||
    kdf.iterations > MAX_KDF.iterations ||
    kdf.parallelism < 1 ||
    kdf.parallelism > MAX_KDF.parallelism ||
    fromB64(kdf.salt).length < 16
  ) {
    throw new UnsafeKdfError()
  }
}

// Crockford base32 without look-alike characters (I, L, O, U). 25 chars ≈ 125 bits.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateRecoveryCode(): string {
  const bytes = randomBytes(25)
  const chars = Array.from(bytes, (b) => B32[b & 31])
  return chars.join('').match(/.{5}/g)!.join('-')
}

export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

// ---------------------------------------------------------------- attachments

/** What a non-image file carries inside its ciphertext. */
export interface AttachmentFile {
  /** The file's own name, e.g. "report.pdf". */
  name: string
  /** The MIME type the uploader declared. Never use it to display the bytes in the app's origin. */
  type: string
}

const MAX_FILE_NAME = 255

/**
 * Encrypt an attachment for upload. The result is `iv || AES-GCM(plaintext)` with AAD
 * "blob:<id>", so the server learns neither the content, the file type nor the file name
 * and cannot hand back one attachment in place of another. The plaintext is
 *
 *   image:  type-length (1 byte, never 0) || type || bytes
 *   file:   0x00 || header-length (2 bytes, big endian) || JSON {"name","type"} || bytes
 *
 * Pass `name` to store a file; without it the image layout is used.
 */
export async function encryptBlob(dek: CryptoKey, id: string, bytes: Uint8Array, type: string, name?: string): Promise<Uint8Array<ArrayBuffer>> {
  let head: Uint8Array
  if (name === undefined) {
    const typeBytes = enc(type)
    if (!typeBytes.length || typeBytes.length > 255) throw new Error('Attachment type is empty or too long')
    head = concat(new Uint8Array([typeBytes.length]), typeBytes)
  } else {
    const meta: AttachmentFile = { name: name.slice(0, MAX_FILE_NAME), type: type.slice(0, 255) }
    const header = enc(JSON.stringify(meta))
    head = concat(new Uint8Array([0, header.length >> 8, header.length & 0xff]), header)
  }
  const iv = randomBytes(IV_BYTES)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc(`blob:${id}`) }, dek, concat(head, bytes))
  return concat(iv, new Uint8Array(ct))
}

/**
 * Decrypt an attachment. `type` is an image type clients accept, or
 * "application/octet-stream" for everything else; `file` is set for a stored file.
 */
export async function decryptBlob(
  dek: CryptoKey,
  id: string,
  data: Uint8Array,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string; file?: AttachmentFile }> {
  if (data.length <= IV_BYTES) throw new Error('Attachment is empty')
  const pt = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: data.slice(0, IV_BYTES), additionalData: enc(`blob:${id}`) },
      dek,
      data.slice(IV_BYTES),
    ),
  )
  const typeLength = pt[0] ?? 0
  if (typeLength === 0) {
    if (pt.length < 3) throw new Error('Attachment is damaged')
    const end = 3 + ((pt[1] << 8) | pt[2])
    if (end > pt.length) throw new Error('Attachment is damaged')
    const meta: unknown = JSON.parse(new TextDecoder().decode(pt.subarray(3, end)))
    const field = (key: string) => {
      const value = (meta as Record<string, unknown> | null)?.[key]
      return typeof value === 'string' ? value : ''
    }
    return { bytes: pt.slice(end), type: 'application/octet-stream', file: { name: field('name').slice(0, MAX_FILE_NAME), type: field('type') } }
  }
  const type = new TextDecoder().decode(pt.subarray(1, 1 + typeLength))
  return {
    bytes: pt.slice(1 + typeLength),
    type: (ATTACHMENT_TYPES as readonly string[]).includes(type) ? type : 'application/octet-stream',
  }
}

function randomBytes(n: number) {
  return crypto.getRandomValues(new Uint8Array(n))
}

function enc(s: string) {
  return new TextEncoder().encode(s)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

export function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
