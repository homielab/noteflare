import type {
  ApiToken,
  BatchNoteItem,
  BatchResult,
  CreateTokenBody,
  CreateTokenResponse,
  EncryptedNote,
  MeResponse,
  PutNoteBody,
  PasskeyRecord,
  CreateShareBody,
  ShareInfo,
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

export interface PutBlobOptions {
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** Upload with progress and cancel, which fetch can't do. Network failures are TypeErrors, as with fetch. */
function putBlobWithProgress(id: string, data: Uint8Array<ArrayBuffer>, { onProgress, signal }: PutBlobOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => new DOMException('Aborted', 'AbortError')
    if (signal?.aborted) return reject(aborted())
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/blobs/${id}`)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {}
      reject(new ApiError(xhr.status, body))
    }
    xhr.onerror = () => reject(new TypeError('Network error'))
    xhr.onabort = () => reject(aborted())
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(data)
  })
}

/** First-run setup of the Cloudflare Access login (no sign-in yet). */
export interface SetupInfo {
  needed: boolean
  host?: string
  emails?: string
  tokenUrl?: string
}

export const api = {
  setupInfo: () => req<SetupInfo>('/setup'),
  setup: (token: string, emails: string) =>
    req<{ ok: true; teamDomain: string }>('/setup', { method: 'POST', body: JSON.stringify({ token, emails }) }),
  me: () => req<MeResponse>('/me'),
  startUpdate: () => req<{ ok: true }>('/update', { method: 'POST', body: '{}' }),
  version: (refresh = false) => req<VersionInfo>(refresh ? '/version?refresh=1' : '/version'),
  getVault: () => req<VaultRecord>('/vault'),
  putVault: (v: VaultRecord) => req<{ version: number }>('/vault', { method: 'PUT', body: JSON.stringify(v) }),
  addPasskey: (p: Omit<PasskeyRecord, 'createdAt'>) => req<PasskeyRecord>('/passkeys', { method: 'POST', body: JSON.stringify(p) }),
  listShares: () => req<ShareInfo[]>('/shares'),
  createShare: (body: CreateShareBody) => req<ShareInfo>('/shares', { method: 'POST', body: JSON.stringify(body) }),
  revokeShare: (id: string) => req<void>(`/shares/${id}`, { method: 'DELETE' }),
  removePasskey: (id: string) => req<void>(`/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
  putBlob: (id: string, data: Uint8Array<ArrayBuffer>, opts?: PutBlobOptions) =>
    opts
      ? putBlobWithProgress(id, data, opts)
      : raw(`/blobs/${id}`, { method: 'PUT', body: data, headers: { 'Content-Type': 'application/octet-stream' } }).then(() => undefined),
  getBlob: (id: string) => raw(`/blobs/${id}`).then(async (res) => new Uint8Array(await res.arrayBuffer())),
  listBackups: () => req<{ backups: { date: string; size: number }[] }>('/backups').then((r) => r.backups),
  getBackup: (date: string) => raw(`/backups/${date}`).then((res) => res.text()),
  deleteBlob: (id: string) => raw(`/blobs/${id}`, { method: 'DELETE' }).then(() => undefined),
}
