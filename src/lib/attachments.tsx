/**
 * Encrypted attachments. A file is encrypted on this device, stored by the server as an
 * opaque blob, and referenced from a note as ordinary Markdown:
 *
 *   ![photo](/api/blobs/<id>)             an image, shown in the note
 *   [report.pdf (1.2 MB)](/api/blobs/<id>)   any other file, shown as a chip that downloads it
 *
 * An image link may end with `#w=<width>&h=<height>` (pixels): the app writes it for new
 * uploads so the box is reserved before the image loads. It never reaches the server, is
 * optional, and readers ignore keys they don't know. `&t=<id>` names the image's thumbnail:
 * a small version made at upload, encrypted and stored as a blob of its own. It is deleted
 * with its image, is not part of exports, and a link without one (or whose thumbnail is
 * gone) uses the full image.
 *
 * Rendering an image fetches the blob, decrypts it and shows it from a local object URL.
 * Downloaded blobs are kept on the device as ciphertext (`blobCache.ts`), so an image seen
 * once shows offline.
 * A file is fetched and decrypted only when its chip is clicked; its name and type live
 * inside the ciphertext. The feature is on only when the deployment has an R2 bucket bound
 * (see wrangler.jsonc).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Paperclip } from 'lucide-react'
import { toast } from 'sonner'
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from '../../shared/types'
import { api, ApiError } from './api'
import { blobCache, type BlobCache, type BlobKind } from './blobCache'
import { decryptBlob, encryptBlob } from './crypto'
import { downloadFile } from './exportNotes'
import { imageAlt } from './importMarkdown'
import { useI18n } from '../i18n'
import { ImagePlaceholder, type ImageFailure } from '../components/ImagePlaceholder'

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const URL_RE = new RegExp(`/api/blobs/(${ID})(?:#([\\w=&.-]*))?`, 'gi')
const ID_RE = new RegExp(`^${ID}$`, 'i')
const EXACT_RE = new RegExp(`^/api/blobs/(${ID})(?:#([\\w=&.-]*))?$`, 'i')
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' }

export function attachmentUrl(id: string, size?: { w: number; h: number }, thumbId?: string) {
  const fragment = [size && `w=${size.w}&h=${size.h}`, thumbId && `t=${thumbId}`].filter(Boolean).join('&')
  return `/api/blobs/${id}${fragment ? `#${fragment}` : ''}`
}
const thumbIdIn = (fragment: string | undefined) => {
  const t = fragment ? new URLSearchParams(fragment).get('t') : null
  return t && ID_RE.test(t) ? t.toLowerCase() : null
}
/** The id of the thumbnail an attachment link names, if any. */
export const attachmentThumbId = (src: unknown) => (typeof src === 'string' ? thumbIdIn(EXACT_RE.exec(src)?.[2]) : null)
/** The pixel size recorded in an attachment link's fragment, if it has a valid one. */
export function attachmentSize(src: unknown): { w: number; h: number } | null {
  const fragment = typeof src === 'string' ? EXACT_RE.exec(src)?.[2] : undefined
  if (!fragment) return null
  const params = new URLSearchParams(fragment)
  const dim = (key: string) => {
    const v = params.get(key)
    return v !== null && /^\d+$/.test(v) && +v >= 1 && +v <= 100000 ? +v : null
  }
  const w = dim('w')
  const h = dim('h')
  return w && h ? { w, h } : null
}
/** The attachment id if `src` is exactly an attachment URL. */
export const attachmentIdOf = (src: unknown) => (typeof src === 'string' ? (EXACT_RE.exec(src)?.[1].toLowerCase() ?? null) : null)
/** Every attachment a note's Markdown refers to. */
export const attachmentIds = (body: string) => [...new Set(Array.from(body.matchAll(URL_RE), (m) => m[1].toLowerCase()))]

/** Every blob a note's Markdown keeps alive: its attachments and their thumbnails. */
export const attachmentBlobIds = (body: string) => [
  ...new Set(
    Array.from(body.matchAll(URL_RE)).flatMap((m) => {
      const thumb = thumbIdIn(m[2])
      return thumb ? [m[1].toLowerCase(), thumb] : [m[1].toLowerCase()]
    }),
  ),
]
/** The blobs that notes being deleted forever used and no remaining note does. Arguments are note bodies. */
export function unusedAttachments(deleted: string[], remaining: string[]) {
  const used = new Set(remaining.flatMap(attachmentBlobIds))
  return [...new Set(deleted.flatMap(attachmentBlobIds))].filter((id) => !used.has(id))
}
/**
 * What a grid of images should load for an image link: its thumbnail when it has one,
 * else the full image. `full` is always the image itself, the fallback for a thumbnail that is gone.
 */
export function gridSource(src: unknown): { id: string; kind: BlobKind; full: string } | null {
  const full = attachmentIdOf(src)
  if (!full) return null
  const thumb = attachmentThumbId(src)
  return thumb && thumb !== full ? { id: thumb, kind: 'thumb', full } : { id: full, kind: 'full', full }
}

type Attachment = Awaited<ReturnType<typeof decryptBlob>>
const isImage = (type: string) => (ATTACHMENT_TYPES as readonly string[]).includes(type)
/** The extension of a stored file's name, if it is a plain one. */
const extensionOf = (name: string) => /\.([a-z0-9]{1,10})$/i.exec(name)?.[1].toLowerCase()
/** File name of an attachment inside an export. Built from the id, so a stored name can't choose the path. */
export const attachmentExportName = (id: string, a: Attachment) =>
  `${id}.${a.file ? (extensionOf(a.file.name) ?? 'bin') : (EXTENSIONS[a.type] ?? 'bin')}`
/** The name an attachment is saved under: its own, without anything a file system could read as a path. */
export const attachmentDownloadName = (a: Attachment, fallback = '') => {
  const clean = (name: string) =>
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
      .replace(/^[.\s]+/, '')
      .trim()
  const name = clean(a.file?.name ?? '') || clean(fallback) || 'attachment'
  return a.file || extensionOf(name) ? name : `${name}.${EXTENSIONS[a.type] ?? 'bin'}`
}
export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
/** Point attachment links at other locations, e.g. files inside an export. */
export const rewriteAttachments = (body: string, to: (id: string) => string | undefined) =>
  body.replace(URL_RE, (url, id: string) => to(id.toLowerCase()) ?? url)

export class AttachmentError extends Error {
  constructor(public reason: 'size') {
    super(`Attachment rejected: ${reason}`)
  }
}

/** Decrypted images of this session, as object URLs. Cleared when the notebook locks. */
const urls = new Map<string, Promise<string>>()

/** Download and decrypt an attachment of any kind. A copy already on this device is used first. */
export async function loadAttachment(dek: CryptoKey, id: string) {
  const cached = await blobCache.get(id)
  if (cached) {
    try {
      return await decryptBlob(dek, id, cached)
    } catch {
      await blobCache.delete([id])
    }
  }
  return decryptBlob(dek, id, await api.getBlob(id))
}

export type { ImageFailure }
export class ImageLoadError extends Error {
  constructor(public reason: ImageFailure) {
    super(`Image not loaded: ${reason}`)
  }
}

export interface ImageDeps {
  getBlob: (id: string) => Promise<Uint8Array>
  online: () => boolean
  cache?: Pick<BlobCache, 'get' | 'put' | 'delete'>
}

/**
 * Decrypt an image from this device's cache, or download it and keep its ciphertext there.
 * A failure always throws an `ImageLoadError` that says why; `offline` means offline and
 * not on this device. Exported for tests.
 */
export async function loadImage(
  dek: CryptoKey,
  id: string,
  deps: ImageDeps = { getBlob: api.getBlob, online: () => navigator.onLine !== false },
  kind: BlobKind = 'full',
) {
  const cache = deps.cache ?? blobCache
  const open = async (blob: Uint8Array) => {
    let image: Attachment
    try {
      image = await decryptBlob(dek, id, blob)
    } catch {
      throw new ImageLoadError('undecryptable')
    }
    // Only image types are ever shown; anything else in a blob is treated as unreadable.
    if (!isImage(image.type)) throw new ImageLoadError('undecryptable')
    return image
  }
  const cached = await cache.get(id)
  if (cached) {
    try {
      return await open(cached)
    } catch {
      await cache.delete([id]) // a damaged copy: get it again
    }
  }
  let blob: Uint8Array
  try {
    blob = await deps.getBlob(id)
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404) throw new ImageLoadError('deleted')
      if (err.status === 501 && (err.body as { error?: string } | null)?.error === 'attachments_disabled') throw new ImageLoadError('disabled')
      throw new ImageLoadError('network')
    }
    throw new ImageLoadError(deps.online() ? 'network' : 'offline')
  }
  const image = await open(blob)
  await cache.put(id, blob, kind) // only what decrypted, and only as ciphertext
  return image
}

/** The image a grid shows for an image link: its thumbnail, or the full image when there is none or it can't be loaded. */
export async function loadGridImage(dek: CryptoKey, src: string, deps?: ImageDeps) {
  const source = gridSource(src)
  if (!source) throw new ImageLoadError('deleted')
  if (source.kind === 'thumb') {
    try {
      return await loadImage(dek, source.id, deps, 'thumb')
    } catch {
      /* fall back to the full image */
    }
  }
  return loadImage(dek, source.full, deps, 'full')
}

function attachmentObjectUrl(dek: CryptoKey, id: string): Promise<string> {
  let url = urls.get(id)
  if (!url) {
    url = loadImage(dek, id).then((image) => URL.createObjectURL(new Blob([image.bytes], { type: image.type })))
    urls.set(id, url)
    url.catch(() => urls.delete(id)) // let a later render try again
  }
  return url
}

/** Object URL of what a grid shows for an image link: its thumbnail, or the full image when there is none or it can't be loaded. */
export function gridObjectUrl(dek: CryptoKey, src: string): Promise<string> {
  const source = gridSource(src)
  if (!source) return Promise.reject(new ImageLoadError('deleted'))
  if (source.kind === 'full') return attachmentObjectUrl(dek, source.full)
  let url = urls.get(source.id)
  if (!url) {
    url = loadImage(dek, source.id, undefined, 'thumb')
      .then((image) => URL.createObjectURL(new Blob([image.bytes], { type: image.type })))
      .catch(() => attachmentObjectUrl(dek, source.full))
    urls.set(source.id, url)
    url.catch(() => urls.delete(source.id))
  }
  return url
}

export function clearAttachments() {
  for (const url of urls.values()) void url.then((u) => URL.revokeObjectURL(u)).catch(() => {})
  urls.clear()
}

/** Longest side of a thumbnail, in pixels. */
export const THUMBNAIL_SIDE = 400

/** True when GIF bytes hold more than one frame. */
function isAnimatedGif(bytes: Uint8Array) {
  let frames = 0
  // Each frame starts with a graphic control extension: 21 F9 04, four bytes, 00.
  for (let i = 0; i + 8 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04 && bytes[i + 7] === 0x00 && ++frames > 1) return true
  }
  return false
}

export interface ImageInfo {
  /** Pixel size, when the browser can tell. */
  size?: { w: number; h: number }
  /** A small version; absent when the image is already small, is an animated GIF, or can't be made. */
  thumb?: { bytes: Uint8Array; type: string }
}

/** Measure an image file and make its thumbnail. Never throws. */
async function inspectImage(file: File, bytes: Uint8Array): Promise<ImageInfo> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return {}
  }
  const size = { w: bitmap.width, h: bitmap.height }
  try {
    const longest = Math.max(size.w, size.h)
    if (longest <= THUMBNAIL_SIDE || (file.type === 'image/gif' && isAnimatedGif(bytes))) return { size }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round((size.w * THUMBNAIL_SIDE) / longest))
    canvas.height = Math.max(1, Math.round((size.h * THUMBNAIL_SIDE) / longest))
    const ctx = canvas.getContext('2d')
    if (!ctx) return { size }
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.8))
    let out = await encode('image/webp')
    if (out?.type !== 'image/webp') {
      // This browser can't write WebP: JPEG, on white where the image is transparent.
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      out = await encode('image/jpeg')
    }
    if (!out || !isImage(out.type) || out.size >= file.size) return { size }
    return { size, thumb: { bytes: new Uint8Array(await out.arrayBuffer()), type: out.type } }
  } catch {
    return { size }
  } finally {
    bitmap.close()
  }
}

export interface UploadDeps {
  putBlob: typeof api.putBlob
  deleteBlob: (id: string) => Promise<void>
  inspect: (file: File, bytes: Uint8Array) => Promise<ImageInfo>
  cache: Pick<BlobCache, 'put' | 'delete'>
}

/**
 * Encrypt and upload a file; returns the Markdown that shows it. Images the app can
 * display go inline, everything else becomes a link that downloads the file.
 * An image also gets a thumbnail, encrypted and uploaded as a second blob and named in
 * the link (`t=`); a thumbnail that can't be made or stored never fails the upload.
 * Aborting `signal` cancels the upload and throws an AbortError; a blob that may have
 * reached the server is deleted.
 */
export async function uploadAttachment(
  dek: CryptoKey,
  file: File,
  opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
  deps: Partial<UploadDeps> = {},
): Promise<string> {
  const { putBlob = api.putBlob, deleteBlob = api.deleteBlob, inspect = inspectImage, cache = blobCache } = deps
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError('size')
  const id = crypto.randomUUID()
  const bytes = new Uint8Array(await file.arrayBuffer())
  const label = (text: string) => text.replace(/[[\]\n\r]/g, ' ').trim()
  const image = isImage(file.type)
  const blob = image ? await encryptBlob(dek, id, bytes, file.type) : await encryptBlob(dek, id, bytes, file.type || 'application/octet-stream', file.name)
  const aborted = () => new DOMException('Aborted', 'AbortError')
  const remove = (blobId: string) => void deleteBlob(blobId).catch(() => {})
  try {
    await putBlob(id, blob, opts)
  } catch (err) {
    if (opts?.signal?.aborted) remove(id)
    throw err
  }
  if (opts?.signal?.aborted) {
    remove(id)
    throw aborted()
  }
  if (!image) return `[${label(file.name) || 'file'} (${formatBytes(file.size)})](${attachmentUrl(id)})`

  const { size, thumb } = await inspect(file, bytes).catch((): ImageInfo => ({}))
  let thumbId: string | undefined
  if (thumb) {
    const candidate = crypto.randomUUID()
    try {
      const small = await encryptBlob(dek, candidate, thumb.bytes, thumb.type)
      await putBlob(candidate, small, opts?.signal ? { signal: opts.signal } : undefined)
      await cache.put(candidate, small, 'thumb')
      thumbId = candidate
    } catch {
      remove(candidate) // it may have reached the server; the link goes without it
    }
    if (opts?.signal?.aborted) {
      remove(id)
      remove(candidate)
      void cache.delete([candidate])
      throw aborted()
    }
  }
  await cache.put(id, blob, 'full') // shows offline from now on
  urls.set(id, Promise.resolve(URL.createObjectURL(file))) // no need to download what we just sent
  return `![${imageAlt(file.name)}](${attachmentUrl(id, size, thumbId)})`
}

/** Best-effort removal of blobs that no note refers to any more, from the server and this device. */
export function deleteAttachments(ids: string[], deps: { deleteBlob: (id: string) => Promise<void>; cache: Pick<BlobCache, 'delete'> } = { deleteBlob: api.deleteBlob, cache: blobCache }) {
  void deps.cache.delete(ids)
  for (const id of ids) {
    void deps.deleteBlob(id).catch(() => {})
    void urls.get(id)?.then((u) => URL.revokeObjectURL(u)).catch(() => {})
    urls.delete(id)
  }
}

// ---------------------------------------------------------------- React

export interface AttachmentsState {
  dek: CryptoKey
  /** False when the deployment has no attachment storage: existing links still render if they can. */
  enabled: boolean
}

export const AttachmentsContext = createContext<AttachmentsState | null>(null)
export const useAttachments = () => useContext(AttachmentsContext)

/** An attachment inside rendered Markdown. */
export function AttachmentImage({ id, alt, width, height }: { id: string; alt?: string; width?: number; height?: number }) {
  const dek = useAttachments()?.dek
  const [state, setState] = useState<{ url?: string; failure?: ImageFailure }>({})
  const [attempt, setAttempt] = useState(0)
  const retry = () => setAttempt((n) => n + 1)

  useEffect(() => {
    if (!dek) return setState({ failure: 'undecryptable' })
    let live = true
    setState({})
    attachmentObjectUrl(dek, id).then(
      (url) => live && setState({ url }),
      (err) => live && setState({ failure: err instanceof ImageLoadError ? err.reason : 'network' }),
    )
    return () => {
      live = false
    }
  }, [dek, id, attempt])

  // Offline: load again as soon as the connection is back.
  const offline = state.failure === 'offline'
  useEffect(() => {
    if (!offline) return
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [offline])

  if (state.url) return <img src={state.url} alt={alt ?? ''} draggable={false} width={width} height={height} />
  return <ImagePlaceholder state={state.failure ?? 'loading'} alt={alt} width={width} height={height} onRetry={retry} />
}

/** Download, decrypt and save a file attachment. `label` names it when the file carries no name. Throws when it can't be loaded. */
export async function downloadAttachment(dek: CryptoKey, id: string, label: string): Promise<void> {
  const file = await loadAttachment(dek, id)
  // Always saved as a download with a neutral type: a decrypted file never opens inside the app's origin.
  downloadFile(attachmentDownloadName(file, label.replace(/\s*\([^()]*\)\s*$/, '')), file.bytes, 'application/octet-stream')
}

/**
 * A file attachment inside rendered Markdown: a chip showing the link's text (name and size).
 * Clicking it downloads, decrypts and saves the file under the name stored inside it.
 */
export function AttachmentFile({ id, children }: { id: string; children?: ReactNode }) {
  const { t } = useI18n()
  const dek = useAttachments()?.dek
  const [busy, setBusy] = useState(false)

  const download = async (label: string) => {
    if (!dek || busy) return
    setBusy(true)
    try {
      await downloadAttachment(dek, id, label)
    } catch {
      toast.error(t('att.downloadFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-foreground/[0.07] px-2 py-1 align-middle text-sm hover:bg-foreground/[0.12] disabled:opacity-60"
      title={t('att.download')}
      disabled={!dek}
      aria-busy={busy}
      onClick={(e) => {
        e.stopPropagation()
        void download(e.currentTarget.textContent ?? '')
      }}
    >
      <Paperclip className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
    </button>
  )
}
