import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from '../../shared/types'
import type { ParsedNote } from './importMarkdown'

export interface ImageSkips {
  off: number
  missing: number
  tooLarge: number
  unsupported: number
  failed: number
}

export interface AttachOptions {
  /** False when the deployment has no attachment storage. */
  enabled: boolean
  /** The file an image of this note names, when the import contains it. */
  find: (note: ParsedNote, name: string) => File | undefined
  /** Encrypts and uploads; resolves to the Markdown that shows the image. */
  upload: (file: File) => Promise<string>
  onProgress?: (done: number, total: number) => void
}

export function findMedia(media: Map<string, File>, sourcePath: string, name: string): File | undefined {
  const lastSlash = sourcePath.lastIndexOf('/')
  const dir = lastSlash === -1 ? '' : sourcePath.slice(0, lastSlash)
  const candidate = dir ? `${dir}/${name}` : name
  const file = media.get(candidate)
  if (file) return file
  if (/\.jpeg$/i.test(name)) {
    const alt = dir ? `${dir}/${name.replace(/\.jpeg$/i, '.jpg')}` : name.replace(/\.jpeg$/i, '.jpg')
    return media.get(alt)
  }
  if (/\.jpg$/i.test(name)) {
    const alt = dir ? `${dir}/${name.replace(/\.jpg$/i, '.jpeg')}` : name.replace(/\.jpg$/i, '.jpeg')
    return media.get(alt)
  }
  return undefined
}

/** Upload the images the notes list and append them to each body. Notes left with no title and no body are dropped. */
export async function attachImportImages(
  notes: ParsedNote[],
  opts: AttachOptions,
): Promise<{ notes: ParsedNote[]; skips: ImageSkips }> {
  const skips: ImageSkips = { off: 0, missing: 0, tooLarge: 0, unsupported: 0, failed: 0 }
  const isSupported = (type: string) => (ATTACHMENT_TYPES as readonly string[]).includes(type)

  let total = 0
  for (const n of notes) {
    if (n.images) {
      for (const img of n.images) {
        if (isSupported(img.type)) total++
      }
    }
  }

  let done = 0
  const out: ParsedNote[] = []

  for (const note of notes) {
    if (!note.images?.length) {
      if (!note.title.trim() && !note.body.trim()) continue
      out.push(note)
      continue
    }

    const markdown: string[] = []
    for (const image of note.images) {
      if (!isSupported(image.type)) {
        skips.unsupported++
        continue
      }
      if (!opts.enabled) {
        skips.off++
      } else {
        const file = opts.find(note, image.name)
        if (!file) {
          skips.missing++
        } else if (file.size > MAX_ATTACHMENT_BYTES) {
          skips.tooLarge++
        } else {
          try {
            const uploadFile = new File([file], image.name, { type: image.type, lastModified: file.lastModified })
            const md = await opts.upload(uploadFile)
            markdown.push(md)
          } catch {
            skips.failed++
          }
        }
      }
      if (opts.enabled) {
        done++
        opts.onProgress?.(done, total)
      }
    }

    const nextBody = [note.body, ...markdown].filter(Boolean).join('\n\n')
    const nextNote: ParsedNote = {
      ...note,
      body: nextBody,
      images: undefined,
    }
    if (!nextNote.title.trim() && !nextNote.body.trim()) continue
    out.push(nextNote)
  }

  return { notes: out, skips }
}
