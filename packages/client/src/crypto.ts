/**
 * End-to-end encryption for notes. Everything here runs in the browser;
 * the server only receives ciphertext and wrapped keys.
 *
 *   passphrase ──Argon2id──► KEK ─┐
 *                                 ├─ AES-GCM wrap ─► wrappedDek  (in D1)
 *   recovery code ──HKDF──► RKEK ─┘                  recoveryDek (in D1)
 *
 *   DEK (random AES-256-GCM) ──► encrypts each note, AAD = "note:<id>"
 */
// hash-wasm (Argon2id) is loaded on first use, so it isn't part of an app's first download.
let argon2: Promise<typeof import('hash-wasm')['argon2id']> | null = null
/** Start loading the key-derivation code early, e.g. while the passphrase is being typed. */
export const preloadKdf = () => (argon2 ??= import('hash-wasm').then((m) => m.argon2id))
import type { KdfParams, VaultRecord } from './protocol.js'

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
  }
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

function randomBytes(n: number) {
  return crypto.getRandomValues(new Uint8Array(n))
}

function enc(s: string) {
  return new TextEncoder().encode(s)
}

function concat(a: Uint8Array, b: Uint8Array) {
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
