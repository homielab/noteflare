/**
 * Encrypted image attachments. An image is encrypted on this device, stored by the server
 * as an opaque blob, and referenced from a note as ordinary Markdown:
 *
 *   ![photo](/api/blobs/<id>)
 *
 * Rendering fetches the blob, decrypts it and shows it from a local object URL.
 * The feature is on only when the deployment has an R2 bucket bound (see wrangler.jsonc).
 */
import { createContext, useContext, useEffect, useState } from 'react'
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from '../../shared/types'
import { api } from './api'
import { decryptBlob, encryptBlob } from './crypto'
import { useI18n } from '../i18n'

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const URL_RE = new RegExp(`/api/blobs/(${ID})`, 'gi')
const EXACT_RE = new RegExp(`^/api/blobs/(${ID})$`, 'i')
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' }

export const attachmentUrl = (id: string) => `/api/blobs/${id}`
/** The attachment id if `src` is exactly an attachment URL. */
export const attachmentIdOf = (src: unknown) => (typeof src === 'string' ? (EXACT_RE.exec(src)?.[1].toLowerCase() ?? null) : null)
/** Every attachment a note's Markdown refers to. */
export const attachmentIds = (body: string) => [...new Set(Array.from(body.matchAll(URL_RE), (m) => m[1].toLowerCase()))]
export const attachmentExtension = (type: string) => EXTENSIONS[type] ?? 'bin'
/** Point attachment links at other locations, e.g. files inside an export. */
export const rewriteAttachments = (body: string, to: (id: string) => string | undefined) =>
  body.replace(URL_RE, (url, id: string) => to(id.toLowerCase()) ?? url)

export class AttachmentError extends Error {
  constructor(public reason: 'type' | 'size') {
    super(`Attachment rejected: ${reason}`)
  }
}

/** Decrypted images of this session, as object URLs. Cleared when the notebook locks. */
const urls = new Map<string, Promise<string>>()

export async function loadAttachment(dek: CryptoKey, id: string) {
  const image = await decryptBlob(dek, id, await api.getBlob(id))
  // Only image types are ever shown; anything else in a blob is treated as unreadable.
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(image.type)) throw new Error('Not an image')
  return image
}

function attachmentObjectUrl(dek: CryptoKey, id: string): Promise<string> {
  let url = urls.get(id)
  if (!url) {
    url = loadAttachment(dek, id).then((image) => URL.createObjectURL(new Blob([image.bytes], { type: image.type })))
    urls.set(id, url)
    url.catch(() => urls.delete(id)) // let a later render try again
  }
  return url
}

export function clearAttachments() {
  for (const url of urls.values()) void url.then((u) => URL.revokeObjectURL(u)).catch(() => {})
  urls.clear()
}

/** Encrypt and upload an image; returns the Markdown that shows it. */
export async function uploadImage(dek: CryptoKey, file: File): Promise<string> {
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(file.type)) throw new AttachmentError('type')
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError('size')
  const id = crypto.randomUUID()
  await api.putBlob(id, await encryptBlob(dek, id, new Uint8Array(await file.arrayBuffer()), file.type))
  urls.set(id, Promise.resolve(URL.createObjectURL(file))) // no need to download what we just sent
  const alt = file.name.replace(/\.[^.]+$/, '').replace(/[[\]\n\r]/g, ' ').trim() || 'image'
  return `![${alt}](${attachmentUrl(id)})`
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
export function AttachmentImage({ id, alt }: { id: string; alt?: string }) {
  const { t } = useI18n()
  const dek = useAttachments()?.dek
  const [state, setState] = useState<{ url?: string; failed?: boolean }>({})

  useEffect(() => {
    if (!dek) return setState({ failed: true })
    let live = true
    setState({})
    attachmentObjectUrl(dek, id).then(
      (url) => live && setState({ url }),
      () => live && setState({ failed: true }),
    )
    return () => {
      live = false
    }
  }, [dek, id])

  if (state.url) return <img src={state.url} alt={alt ?? ''} draggable={false} />
  return (
    <span className="inline-block rounded bg-foreground/[0.07] px-2 py-1 text-xs text-muted-foreground" role={state.failed ? undefined : 'status'}>
      {state.failed ? t('att.unavailable') : t('att.loading')}
      {alt ? ` · ${alt}` : ''}
    </span>
  )
}
