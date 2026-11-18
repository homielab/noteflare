/**
 * Encrypted attachments. A file is encrypted on this device, stored by the server as an
 * opaque blob, and referenced from a note as ordinary Markdown:
 *
 *   ![photo](/api/blobs/<id>)             an image, shown in the note
 *   [report.pdf (1.2 MB)](/api/blobs/<id>)   any other file, shown as a chip that downloads it
 *
 * An image link may end with `#w=<width>&h=<height>` (pixels): the app writes it for new
 * uploads so the box is reserved before the image loads. It never reaches the server, is
 * optional, and readers ignore keys they don't know.
 *
 * Rendering an image fetches the blob, decrypts it and shows it from a local object URL.
 * A file is fetched and decrypted only when its chip is clicked; its name and type live
 * inside the ciphertext. The feature is on only when the deployment has an R2 bucket bound
 * (see wrangler.jsonc).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Paperclip } from 'lucide-react'
import { toast } from 'sonner'
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from '../../shared/types'
import { api, ApiError } from './api'
import { decryptBlob, encryptBlob } from './crypto'
import { downloadFile } from './exportNotes'
import { useI18n } from '../i18n'
import { ImagePlaceholder, type ImageFailure } from '../components/ImagePlaceholder'

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const URL_RE = new RegExp(`/api/blobs/(${ID})(?:#[\\w=&.-]*)?`, 'gi')
const EXACT_RE = new RegExp(`^/api/blobs/(${ID})(?:#([\\w=&.-]*))?$`, 'i')
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' }

export const attachmentUrl = (id: string, size?: { w: number; h: number }) =>
  `/api/blobs/${id}${size ? `#w=${size.w}&h=${size.h}` : ''}`
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

/** Download and decrypt an attachment of any kind. */
export const loadAttachment = async (dek: CryptoKey, id: string) => decryptBlob(dek, id, await api.getBlob(id))

export type { ImageFailure }
export class ImageLoadError extends Error {
  constructor(public reason: ImageFailure) {
    super(`Image not loaded: ${reason}`)
  }
}

/** Download and decrypt an image; a failure always throws an `ImageLoadError` that says why. Exported for tests. */
export async function loadImage(
  dek: CryptoKey,
  id: string,
  deps: { getBlob: (id: string) => Promise<Uint8Array>; online: () => boolean } = { getBlob: api.getBlob, online: () => navigator.onLine !== false },
) {
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

function attachmentObjectUrl(dek: CryptoKey, id: string): Promise<string> {
  let url = urls.get(id)
  if (!url) {
    url = loadImage(dek, id).then((image) => URL.createObjectURL(new Blob([image.bytes], { type: image.type })))
    urls.set(id, url)
    url.catch(() => urls.delete(id)) // let a later render try again
  }
  return url
}

export function clearAttachments() {
  for (const url of urls.values()) void url.then((u) => URL.revokeObjectURL(u)).catch(() => {})
  urls.clear()
}

/** Pixel size of an image file, or undefined when the browser can't tell. */
async function imageSize(file: File) {
  try {
    const bitmap = await createImageBitmap(file)
    const size = { w: bitmap.width, h: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return undefined
  }
}

/**
 * Encrypt and upload a file; returns the Markdown that shows it. Images the app can
 * display go inline, everything else becomes a link that downloads the file.
 * Aborting `signal` cancels the upload and throws an AbortError; a blob that may have
 * reached the server is deleted.
 */
export async function uploadAttachment(
  dek: CryptoKey,
  file: File,
  opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
): Promise<string> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError('size')
  const id = crypto.randomUUID()
  const bytes = new Uint8Array(await file.arrayBuffer())
  const label = (text: string) => text.replace(/[[\]\n\r]/g, ' ').trim()
  const image = isImage(file.type)
  const blob = image ? await encryptBlob(dek, id, bytes, file.type) : await encryptBlob(dek, id, bytes, file.type || 'application/octet-stream', file.name)
  const aborted = () => new DOMException('Aborted', 'AbortError')
  try {
    await api.putBlob(id, blob, opts)
  } catch (err) {
    if (opts?.signal?.aborted) void api.deleteBlob(id).catch(() => {})
    throw err
  }
  if (opts?.signal?.aborted) {
    void api.deleteBlob(id).catch(() => {})
    throw aborted()
  }
  if (image) {
    const size = await imageSize(file)
    urls.set(id, Promise.resolve(URL.createObjectURL(file))) // no need to download what we just sent
    return `![${label(file.name.replace(/\.[^.]+$/, '')) || 'image'}](${attachmentUrl(id, size)})`
  }
  return `[${label(file.name) || 'file'} (${formatBytes(file.size)})](${attachmentUrl(id)})`
}

/** Best-effort removal of attachments that no note refers to any more. */
export function deleteAttachments(ids: string[]) {
  for (const id of ids) {
    void api.deleteBlob(id).catch(() => {})
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
      const file = await loadAttachment(dek, id)
      // Always saved as a download with a neutral type: a decrypted file never opens inside the app's origin.
      downloadFile(attachmentDownloadName(file, label.replace(/\s*\([^()]*\)\s*$/, '')), file.bytes, 'application/octet-stream')
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
