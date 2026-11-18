import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Paperclip, StickyNote } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Segmented } from '@/components/ui/segmented'
import { useI18n } from '@/i18n'
import {
  AttachmentImage,
  attachmentSize,
  downloadAttachment,
  gridObjectUrl,
  ImageLoadError,
  useAttachments,
} from '@/lib/attachments'
import { inView } from '@/lib/inView'
import { filterLibrary, libraryLabels, type Library, type LibraryItem } from '@/lib/library'
import { ImagePlaceholder, type ImageFailure } from './ImagePlaceholder'
import type { Note } from '@/lib/noteModel'
import { cn } from '@/lib/utils'

function OpenNote({ notes, onOpen }: { notes: Note[]; onOpen: (id: string) => void }) {
  const { t } = useI18n()
  if (!notes.length) return null

  if (notes.length === 1) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={(e) => {
          e.stopPropagation()
          onOpen(notes[0].id)
        }}
      >
        <StickyNote /> {t('lib.openNote')}
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button variant="outline" size="sm">
          <StickyNote /> {t('lib.openNote')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {notes.map((n) => (
          <DropdownMenuItem key={n.id} onSelect={() => onOpen(n.id)}>
            <span className="max-w-[16rem] truncate">{n.title.trim() || t('lib.untitled')}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function LibraryTile({ item, onOpen }: { item: LibraryItem; onOpen: () => void }) {
  const { t } = useI18n()
  const dek = useAttachments()?.dek
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  const [state, setState] = useState<{ url?: string; failure?: ImageFailure }>({})
  const [attempt, setAttempt] = useState(0)
  const retry = () => setAttempt((n) => n + 1)

  useEffect(() => {
    if (!ref.current) return
    return inView.watch(ref.current, () => setSeen(true))
  }, [])

  useEffect(() => {
    if (!seen) return
    if (!dek) {
      setState({ failure: 'undecryptable' })
      return
    }
    let live = true
    setState({})
    gridObjectUrl(dek, item.src).then(
      (url) => live && setState({ url }),
      (err) => live && setState({ failure: err instanceof ImageLoadError ? err.reason : 'network' }),
    )
    return () => {
      live = false
    }
  }, [dek, item.src, attempt, seen])

  const offline = state.failure === 'offline'
  useEffect(() => {
    if (!offline) return
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [offline])

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={item.name || t('lib.image')}
      title={item.name || undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className="relative block aspect-square overflow-hidden rounded-lg bg-foreground/[0.07] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 cursor-pointer"
    >
      {state.url ? (
        <img src={state.url} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
      ) : (
        <ImagePlaceholder fill state={state.failure ?? 'loading'} alt={item.name} onRetry={retry} />
      )}
    </div>
  )
}

function FileRow({ item, onOpenNote }: { item: LibraryItem; onOpenNote: (id: string) => void }) {
  const { t } = useI18n()
  const dek = useAttachments()?.dek
  const [busy, setBusy] = useState(false)

  const handleDownload = async () => {
    if (!dek || busy) return
    setBusy(true)
    try {
      await downloadAttachment(dek, item.id, item.name)
    } catch {
      toast.error(t('att.downloadFailed'))
    } finally {
      setBusy(false)
    }
  }

  const title = item.name || 'file'
  const subtext = [item.size, item.notes[0]?.title.trim() || t('lib.untitled')].filter(Boolean).join(' · ')

  return (
    <li className="flex items-center gap-3 rounded-lg border bg-surface px-3 py-2">
      <button
        type="button"
        title={t('att.download')}
        aria-busy={busy}
        disabled={!dek}
        onClick={handleDownload}
        className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
      >
        <Paperclip className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{subtext}</div>
        </div>
      </button>
      <OpenNote notes={item.notes} onOpen={onOpenNote} />
    </li>
  )
}

export function ImageLibrary({
  library,
  query,
  onOpenNote,
}: {
  library: Library
  query: string
  onOpenNote: (noteId: string) => void
}) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'images' | 'files'>('images')
  const [label, setLabel] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const tabItems = tab === 'images' ? library.images : library.files
  const labels = useMemo(() => libraryLabels(tabItems), [tabItems])
  const activeLabel = label && labels.includes(label) ? label : null
  const shown = useMemo(() => filterLibrary(tabItems, { query, label: activeLabel }), [tabItems, query, activeLabel])

  const index = tab === 'images' && openId ? shown.findIndex((i) => i.id === openId) : -1
  const current = index >= 0 ? shown[index] : null

  const prev = () => {
    if (index > 0) setOpenId(shown[index - 1].id)
  }
  const next = () => {
    if (index >= 0 && index < shown.length - 1) setOpenId(shown[index + 1].id)
  }

  const imagesLabel = library.images.length > 0 ? `${t('lib.tabImages')} ${library.images.length}` : t('lib.tabImages')
  const filesLabel = library.files.length > 0 ? `${t('lib.tabFiles')} ${library.files.length}` : t('lib.tabFiles')

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3">
        <div className="flex items-center">
          <Segmented
            label={t('lib.tabs')}
            value={tab}
            onChange={(v) => {
              setTab(v)
              setOpenId(null)
            }}
            options={[
              { value: 'images', label: imagesLabel },
              { value: 'files', label: filesLabel },
            ]}
          />
        </div>
        {labels.length > 0 && (
          <div role="group" aria-label={t('lib.labelFilter')} className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-pressed={activeLabel === null}
              onClick={() => setLabel(null)}
              className={cn(
                'h-7 rounded-full px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
                activeLabel === null
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-foreground/[0.06] text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {t('lib.allLabels')}
            </button>
            {labels.map((l) => {
              const active = activeLabel === l
              return (
                <button
                  key={l}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setLabel(active ? null : l)}
                  className={cn(
                    'h-7 max-w-[12rem] truncate rounded-full px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-foreground/[0.06] text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  #{l}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {tabItems.length === 0 ? (
        <p className="mt-20 text-center text-sm text-muted-foreground">
          {t(tab === 'images' ? 'lib.emptyImages' : 'lib.emptyFiles')}
        </p>
      ) : shown.length === 0 ? (
        <p className="mt-20 text-center text-sm text-muted-foreground">{t('lib.noMatch')}</p>
      ) : tab === 'images' ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
          {shown.map((item) => (
            <li key={item.id}>
              <LibraryTile item={item} onOpen={() => setOpenId(item.id)} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mx-auto grid max-w-2xl gap-2">
          {shown.map((item) => (
            <FileRow key={item.id} item={item} onOpenNote={onOpenNote} />
          ))}
        </ul>
      )}

      <Dialog open={!!current} onOpenChange={(o) => !o && setOpenId(null)}>
        {current && (
          <DialogContent
            className="max-w-4xl gap-3 p-4"
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                e.preventDefault()
                prev()
              } else if (e.key === 'ArrowRight') {
                e.preventDefault()
                next()
              }
            }}
          >
            <DialogTitle className="truncate pr-10 text-base">{current.name || t('lib.image')}</DialogTitle>
            <div className="grid min-h-40 place-items-center [&_img]:h-auto [&_img]:max-h-[70dvh] [&_img]:w-auto [&_img]:max-w-full [&_img]:rounded-md [&_img]:object-contain">
              <AttachmentImage
                key={current.id}
                id={current.id}
                alt={current.name}
                width={attachmentSize(current.src)?.w}
                height={attachmentSize(current.src)?.h}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" aria-label={t('lib.prev')} disabled={index <= 0} onClick={prev}>
                <ChevronLeft />
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('lib.position', { n: index + 1, total: shown.length })}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('lib.next')}
                disabled={index >= shown.length - 1}
                onClick={next}
              >
                <ChevronRight />
              </Button>
              <div className="ml-auto">
                <OpenNote
                  notes={current.notes}
                  onOpen={(id) => {
                    setOpenId(null)
                    onOpenNote(id)
                  }}
                />
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
