import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { FolderDown } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/i18n'
import type { ImportResult } from '@/lib/notes'
import { filesFromDrop, filesFromInput, isKeepPath, MAX_IMPORT_CHARS, parseMarkdown, type ParsedNote, type SourceFile } from '@/lib/importMarkdown'
import { parseKeepNote } from '@/lib/importKeep'

export interface ImportHandle {
  pickFolder(): void
  pickFiles(): void
  /** Import files handed over by the OS (opened with the installed app). */
  importFiles(files: File[]): void
}

interface Props {
  /** Disabled while a dialog is open or the notebook is locked. */
  enabled: boolean
  onImport: (
    notes: ParsedNote[],
    onProgress: (done: number, total: number) => void,
  ) => Promise<ImportResult>
  onDone?: () => void
}

/**
 * Drop a folder (Markdown files or a Google Keep export) or .md files anywhere on the page to import it.
 * Files are read and parsed in the browser; the store encrypts before upload.
 */
export const ImportDropzone = forwardRef<ImportHandle, Props>(function ImportDropzone({ enabled, onImport, onDone }, ref) {
  const { t } = useI18n()
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const busy = useRef(false)
  const folderInput = useRef<HTMLInputElement>(null)
  const filesInput = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    pickFolder: () => folderInput.current?.click(),
    pickFiles: () => filesInput.current?.click(),
    importFiles: (files) => void run(async () => files.map((file) => ({ path: file.name, file }))),
  }))

  // React doesn't type `webkitdirectory`; set it on the element directly.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '')
  }, [])

  const run = async (collect: () => Promise<SourceFile[]>) => {
    if (busy.current) return
    busy.current = true
    const id = toast.loading(t('imp.reading'))
    try {
      const files = await collect()
      const parsed: ParsedNote[] = []
      let tooLarge = 0
      for (const { path, file } of files) {
        if (file.size > MAX_IMPORT_CHARS * 4) {
          tooLarge++
          continue
        }
        const text = await file.text()
        if (text.length > MAX_IMPORT_CHARS) {
          tooLarge++
          continue
        }
        if (isKeepPath(path)) {
          // Other .json files in the folder (and Keep's trashed notes) are skipped silently.
          const note = parseKeepNote(path, text, file.lastModified)
          if (note) parsed.push(note)
        } else parsed.push(parseMarkdown(path, text, file.lastModified))
      }
      if (!parsed.length) {
        toast.error(tooLarge ? t('imp.tooLarge', { n: tooLarge }) : t('imp.noMarkdown'), { id })
        return
      }

      const res = await onImport(parsed, (done, total) => toast.loading(t('imp.progress', { done, total }), { id }))
      const added = res.created + res.queued
      const details = [
        res.queued && t('imp.queued', { n: res.queued }),
        res.duplicates && t('imp.duplicates', { n: res.duplicates }),
        tooLarge && t('imp.tooLarge', { n: tooLarge }),
        res.failed && t('imp.failed', { n: res.failed }),
      ]
        .filter(Boolean)
        .join(' · ')

      if (!added) toast(t('imp.nothingNew'), { id, description: details || undefined })
      else
        toast.success(added === 1 ? t('imp.doneOne') : t('imp.doneMany', { n: added }), {
          id,
          description: details || undefined,
        })
      if (added) onDone?.()
    } catch {
      toast.error(t('imp.error'), { id })
    } finally {
      busy.current = false
    }
  }

  useEffect(() => {
    if (!enabled) return
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setOver(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (!depth.current) setOver(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      // Entries must be read synchronously inside the drop handler, before the event ends.
      const pending = filesFromDrop(e.dataTransfer!)
      void run(() => pending)
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  })

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    if (list?.length) {
      const files = filesFromInput(list)
      void run(async () => files)
    }
    e.target.value = ''
  }

  return (
    <>
      <input ref={folderInput} type="file" multiple hidden onChange={onPick} />
      <input ref={filesInput} type="file" multiple hidden accept=".md,.markdown,.json,text/markdown,application/json" onChange={onPick} />
      {over && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-background/70 p-6 backdrop-blur-sm animate-in fade-in-0 duration-200">
          <div className="dropzone flex w-full max-w-lg flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-flare bg-surface/90 px-8 py-12 text-center shadow-2xl animate-in zoom-in-95 duration-300">
            <FolderDown className="dropzone-icon size-12 text-flare" strokeWidth={1.6} />
            <p className="text-xl font-semibold">{t('imp.dropTitle')}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{t('imp.dropBody')}</p>
          </div>
        </div>
      )}
    </>
  )
})
