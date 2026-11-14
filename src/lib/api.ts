import type {
  ApiToken,
  BatchNoteItem,
  BatchResult,
  CreateTokenBody,
  CreateTokenResponse,
  EncryptedNote,
  MeResponse,
  PutNoteBody,
  VaultRecord,
} from '../../shared/types'
import type { VersionInfo } from '../../shared/release'

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API ${status}`)
  }
}

/**
 * Network failures (offline) surface as a plain TypeError from fetch;
 * everything the server answered surfaces as ApiError.
 */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    // An expired Cloudflare Access session answers with a redirect to the login
    // page. Don't follow it (it would fail as a CORS error and look like "offline").
    redirect: 'manual',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (res.type === 'opaqueredirect') throw new ApiError(401, null)
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  return body as T
}

/** Binary requests (attachments). GETs may use the HTTP cache: the ciphertext for an id never changes. */
async function raw(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', redirect: 'manual', ...init })
  if (res.type === 'opaqueredirect') throw new ApiError(401, null)
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null))
  return res
}

export const api = {
  me: () => req<MeResponse>('/me'),
  version: (refresh = false) => req<VersionInfo>(refresh ? '/version?refresh=1' : '/version'),
  getVault: () => req<VaultRecord>('/vault'),
  putVault: (v: VaultRecord) => req<{ version: number }>('/vault', { method: 'PUT', body: JSON.stringify(v) }),
  listNotes: (since = 0) => req<EncryptedNote[]>(`/notes?since=${since}`),
  noteIndex: () => req<{ id: string; version: number }[]>('/notes/index'),
  putNote: (id: string, body: PutNoteBody) =>
    req<EncryptedNote>(`/notes/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  createNotes: (notes: BatchNoteItem[]) =>
    req<BatchResult>('/notes/batch', { method: 'POST', body: JSON.stringify({ notes }) }),
  deleteNote: (id: string) => req<void>(`/notes/${id}`, { method: 'DELETE' }),
  listTokens: () => req<ApiToken[]>('/tokens'),
  createToken: (body: CreateTokenBody) =>
    req<CreateTokenResponse>('/tokens', { method: 'POST', body: JSON.stringify(body) }),
  revokeToken: (id: string) => req<void>(`/tokens/${id}`, { method: 'DELETE' }),
  putBlob: (id: string, data: Uint8Array<ArrayBuffer>) =>
    raw(`/blobs/${id}`, { method: 'PUT', body: data, headers: { 'Content-Type': 'application/octet-stream' } }).then(() => undefined),
  getBlob: (id: string) => raw(`/blobs/${id}`).then(async (res) => new Uint8Array(await res.arrayBuffer())),
  deleteBlob: (id: string) => raw(`/blobs/${id}`, { method: 'DELETE' }).then(() => undefined),
}
