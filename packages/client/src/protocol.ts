/**
 * The NoteFlare wire protocol: request/response shapes of the HTTP API.
 * Shared by the Worker, the web app and third-party clients.
 * These fields are all the server ever sees — note content travels only as ciphertext.
 */

export interface KdfParams {
  name: 'argon2id'
  salt: string // base64
  memoryKiB: number
  iterations: number
  parallelism: number
}

export interface VaultRecord {
  kdf: KdfParams
  wrappedDek: string // base64(iv || ciphertext)
  recoveryDek: string // base64(iv || ciphertext)
  version: number
}

export interface EncryptedNote {
  id: string
  ciphertext: string // base64
  iv: string // base64
  pinned: boolean
  archived: boolean
  trashedAt: number | null
  position: number
  version: number
  createdAt: number
  updatedAt: number
}

export interface PutNoteBody {
  ciphertext: string
  iv: string
  pinned: boolean
  archived: boolean
  trashedAt: number | null
  position: number
  /** Version the client is editing; 0 = new note. */
  baseVersion: number
}

export interface MeResponse {
  email: string
  hasVault: boolean
  /** How this request was authenticated. */
  auth: 'session' | 'token'
  /** What the caller may do: a session or write token can change notes; a read token can only read. */
  scope: TokenScope
  /** True when this deployment has storage for encrypted image attachments (an R2 bucket). */
  attachments: boolean
}

// ---------------------------------------------------------------- API tokens

export type TokenScope = 'read' | 'write'

/** A personal access token as listed in the web app (the secret itself is shown only once). */
export interface ApiToken {
  id: string
  name: string
  /** First characters of the token, to recognise it, e.g. "nf_3fK9qa". */
  prefix: string
  scope: TokenScope
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
}

export interface CreateTokenBody {
  name: string
  scope: TokenScope
  /** Days until the token stops working; null = never expires. */
  expiresInDays: number | null
}

export interface CreateTokenResponse {
  /** The secret. Shown once; only its SHA-256 hash is stored. */
  token: string
  info: ApiToken
}

export const TOKEN_PREFIX = 'nf_'
export const MAX_TOKENS_PER_USER = 25

export interface BatchNoteItem extends Omit<PutNoteBody, 'baseVersion'> {
  id: string
}

export interface BatchResult {
  /** Notes created (ids that already exist are skipped). */
  created: { id: string; version: number; createdAt: number; updatedAt: number }[]
  skipped: string[]
}

/** Per-request limits for batch import (D1 Free: at most 50 queries per Worker invocation). */
export const BATCH_MAX_NOTES = 40
export const BATCH_MAX_BYTES = 8 * 1024 * 1024

// ---------------------------------------------------------------- attachments

/** Largest image a note can carry, before encryption. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** Image types clients accept; anything else is refused on upload and never rendered. */
export const ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const
