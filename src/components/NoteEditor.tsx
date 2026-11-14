import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ImagePlus, ListChecks } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Tooltip } from '@/components/ui/tooltip'
import { continueList, indentLines, toggleChecklist, type Edit } from '@/lib/editing'
import { isEmptyNote, toggleTask, type Note, type NotePatch } from '@/lib/notes'
import { supportsViewTransitions, VT_CLASS } from '@/lib/motion'
import { dateLocale, useI18n } from '@/i18n'
import { NoteMarkdown } from './NoteMarkdown'
import { NoteActions, PinButton } from './NoteActions'
import { LabelMenu } from './LabelMenu'
import { colorVar } from './noteColors'
import { AttachmentError, uploadImage, useAttachments } from '@/lib/attachments'

interface Props {
  note: Note | null
  /** View-transition name shared with the card/button that opened the editor, so it grows out of it. */
  transitionName?: string
  allLabels: string[]
  /** 'saving' while a change is being encrypted/pushed; 'local' when offline and saved only on this device. */
  saveState: 'saving' | 'local' | 'idle'
  onSave: (note: Note) => void
  onClose: (note: Note) => void
  onDeleteForever: (id: string) => void
}

export function NoteEditor({ note, transitionName, allLabels, saveState, onSave, onClose, onDeleteForever }: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<Note | null>(note)
  const [preview, setPreview] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const attachments = useAttachments()
  // The newest draft, for work that finishes after an await (image uploads).
  const draftRef = useRef<Note | null>(note)
  draftRef.current = draft

  useEffect(() => {
    setDraft(note)
    setPreview(!!note?.body && note.version > 0) // existing notes open in reading mode
  }, [note?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const focusBody = (atEnd = true) =>
    requestAnimationFrame(() => {
      const el = bodyRef.current
      if (!el) return
      el.focus()
      if (atEnd) el.setSelectionRange(el.value.length, el.value.length)
    })

  const edit = (mode: 'edit' | 'preview') => {
    setPreview(mode === 'preview')
    if (mode === 'edit') focusBody()
  }

  const checklist = () => {
    const el = bodyRef.current
    if (preview || !el) {
      setPreview(false)
      requestAnimationFrame(() => {
        const t = bodyRef.current
        if (!t) return
        t.focus()
        t.setSelectionRange(t.value.length, t.value.length)
        // Start a new checklist item below existing text rather than converting the last line.
        const v = t.value
        if (v && !v.endsWith('\n')) applyTo(t, { from: v.length, to: v.length, text: '\n', selStart: v.length + 1, selEnd: v.length + 1 })
        applyTo(t, toggleChecklist(t.value, t.selectionStart, t.selectionEnd))
      })
      return
    }
    applyTo(el, toggleChecklist(el.value, el.selectionStart, el.selectionEnd))
  }

  const onBodyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    if (e.nativeEvent.isComposing) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      if (draft) onClose(draft)
      return
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      return applyTo(el, toggleChecklist(el.value, el.selectionStart, el.selectionEnd))
    }
    if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
      const ed = continueList(el.value, el.selectionStart, el.selectionEnd)
      if (ed) (e.preventDefault(), applyTo(el, ed))
      return
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      // Indent only inside lists or multi-line selections, so Tab still moves focus elsewhere.
      const { value, selectionStart: a, selectionEnd: b } = el
      const multi = value.slice(a, b).includes('\n')
      const ls = value.lastIndexOf('\n', a - 1) + 1
      const inList = /^\s*([-*+]|\d+[.)])\s/.test(value.slice(ls))
      if (multi || inList) (e.preventDefault(), applyTo(el, indentLines(value, a, b, e.shiftKey)))
    }
  }

  if (!draft) return null
  const isNew = draft.version === 0
  const morph = !!transitionName && supportsViewTransitions()

  const change = (patch: NotePatch, closeAfter = false) => {
    const next = { ...(draftRef.current ?? draft), ...patch, updatedAt: Date.now() }
    draftRef.current = next
    setDraft(next)
    if (!isNew || !isEmptyNote(next)) onSave(next)
    if (closeAfter) onClose(next)
  }

  const canAttach = !!attachments?.enabled && !draft.trashedAt

  /** Encrypt and upload images, then put their Markdown at the cursor (or at the end, in reading mode). */
  const addImages = async (files: File[]) => {
    if (!attachments || !files.length) return
    for (const file of files) {
      const id = toast.loading(t('att.uploading'))
      try {
        const markdown = await uploadImage(attachments.dek, file)
        const el = bodyRef.current
        if (el) {
          const at = el.selectionStart
          const before = at > 0 && el.value[at - 1] !== '\n' ? '\n' : ''
          const text = `${before}${markdown}\n`
          applyTo(el, { from: at, to: el.selectionEnd, text, selStart: at + text.length, selEnd: at + text.length })
        } else {
          const body = draftRef.current?.body ?? ''
          change({ body: body.trim() ? `${body.replace(/\s+$/, '')}\n\n${markdown}\n` : `${markdown}\n` })
        }
        toast.success(t('att.added'), { id })
      } catch (err) {
        const reason = err instanceof AttachmentError ? err.reason : null
        toast.error(reason === 'size' ? t('att.tooLarge') : reason === 'type' ? t('att.badType') : t('att.failed'), { id })
      }
    }
  }
  const imagesOf = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))

  const edited = new Date(draft.updatedAt).toLocaleString(dateLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  })

  const status =
    saveState === 'local' ? t('ed.savedLocally') : saveState === 'saving' ? t('ed.saving') : isNew ? '' : t('ed.edited', { time: edited })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(draft)}>
      <DialogContent
        showClose={false}
        aria-describedby={undefined}
        className="paper max-w-2xl gap-0 rounded-2xl border-0 p-0 shadow-2xl max-sm:top-[var(--vvt,0px)] max-sm:flex max-sm:h-[var(--vvh,100dvh)] max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-y-0 max-sm:flex-col max-sm:overflow-hidden max-sm:rounded-none max-sm:p-0 max-sm:pt-[env(safe-area-inset-top)]"
        overlayStyle={morph ? { viewTransitionName: 'editor-backdrop' } : undefined}
        style={{
          background: colorVar(draft.color),
          ...(morph
            ? {
                viewTransitionName: transitionName,
                viewTransitionClass: VT_CLASS.editor,
                // The view transition already morphs the dialog; drop the default zoom so they don't stack.
                animation: 'none',
              }
            : null),
        }}
        onOpenAutoFocus={(e) => {
          if (!isNew) e.preventDefault()
        }}
      >
        <DialogTitle className="sr-only">{draft.title || t('ed.srTitle')}</DialogTitle>
        <DialogDescription className="sr-only">{t('ed.srDescription')}</DialogDescription>

        <div className="flex items-start gap-2 px-5 pt-4">
          <input
            value={draft.title}
            onChange={(e) => change({ title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
              e.preventDefault()
              if (e.metaKey || e.ctrlKey) onClose(draft)
              else edit('edit')
            }}
            placeholder={t('ed.title')}
            maxLength={300}
            enterKeyHint="next"
            className="min-w-0 flex-1 bg-transparent py-1 text-lg font-semibold outline-none placeholder:text-muted-foreground"
          />
          <PinButton note={draft} onChange={(p) => change(p)} />
          {/* Phones: Done sits at the top, where the thumb and the eye already are. */}
          <Button variant="ghost" size="sm" className="-mr-2 font-semibold sm:hidden" onClick={() => onClose(draft)}>
            {t('ed.done')}
          </Button>
        </div>

        {status && <p className="-mt-1 px-5 text-xs text-muted-foreground sm:hidden">{status}</p>}

        <div
          className="min-h-40 overflow-y-auto overscroll-contain px-5 py-2 max-sm:min-h-0 max-sm:flex-1 sm:max-h-[60vh]"
          onDragOver={(e) => {
            if (canAttach && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
          }}
          onDrop={(e) => {
            const images = imagesOf(e.dataTransfer.files)
            if (!canAttach || !images.length) return
            e.preventDefault()
            void addImages(images)
          }}
        >
          {preview ? (
            <div
              key="preview"
              className="min-h-36 cursor-text animate-in fade-in-0 duration-200"
              onDoubleClick={() => edit('edit')}
              onClick={(e) => {
                // Phones have no double-click: a tap on the text (not a link or checkbox) starts editing.
                if (matchMedia('(pointer: coarse)').matches && !(e.target as HTMLElement).closest('a, input, button, label')) edit('edit')
              }}
              title={t('ed.doubleClick')}
            >
              {draft.body ? (
                <NoteMarkdown source={draft.body} onToggleTask={(i) => change({ body: toggleTask(draft.body, i) })} />
              ) : (
                <p className="text-muted-foreground">{t('ed.noContent')}</p>
              )}
            </div>
          ) : (
            <textarea
              key="edit"
              ref={bodyRef}
              onKeyDown={onBodyKey}
              onPaste={(e) => {
                const images = imagesOf(e.clipboardData.files)
                if (!canAttach || !images.length) return
                e.preventDefault()
                void addImages(images)
              }}
              aria-keyshortcuts="Control+Enter Meta+Enter Control+Shift+L Meta+Shift+L"
              autoFocus={isNew}
              value={draft.body}
              onChange={(e) => change({ body: e.target.value })}
              placeholder={t('ed.body')}
              spellCheck
              className="field-sizing-content min-h-36 w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-muted-foreground animate-in fade-in-0 duration-200"
            />
          )}
        </div>

        {draft.labels.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 px-5 pb-2">
            {draft.labels.map((l) => (
              <li key={l} className="max-w-full">
                <button
                  type="button"
                  className="block max-w-full truncate rounded-full bg-foreground/[0.07] px-2 py-0.5 text-xs hover:line-through"
                  title={t('ed.removeLabel', { l })}
                  onClick={() => change({ labels: draft.labels.filter((x) => x !== l) })}
                >
                  {l}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-0.5 px-3 pb-3 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:[scrollbar-width:none] max-sm:border-t max-sm:border-foreground/10 max-sm:pt-2 max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))] [html[data-keyboard=open]_&]:pb-2">
          {!draft.trashedAt && <LabelMenu value={draft.labels} allLabels={allLabels} onChange={(labels) => change({ labels })} />}
          <NoteActions
            note={draft}
            onChange={(p) => change(p, 'trashedAt' in p || 'archived' in p)}
            onDeleteForever={() => onDeleteForever(draft.id)}
          />
          {!draft.trashedAt && (
            <Tooltip label={t('ed.checklist')}>
              <Button variant="ghost" size="icon-sm" aria-label={t('ed.checklist')} aria-keyshortcuts="Control+Shift+L" onClick={checklist}>
                <ListChecks />
              </Button>
            </Tooltip>
          )}
          {canAttach && (
            <>
              <Tooltip label={t('ed.addImage')}>
                <Button variant="ghost" size="icon-sm" aria-label={t('ed.addImage')} onClick={() => imageInput.current?.click()}>
                  <ImagePlus />
                </Button>
              </Tooltip>
              <input
                ref={imageInput}
                type="file"
                hidden
                multiple
                accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                onChange={(e) => {
                  const images = imagesOf(e.target.files)
                  e.target.value = ''
                  void addImages(images)
                }}
              />
            </>
          )}
          <Segmented
            className="ml-1 shrink-0 max-sm:ml-auto"
            label={t('ed.mode')}
            value={preview ? 'preview' : 'edit'}
            onChange={edit}
            options={[
              { value: 'edit', label: t('ed.edit') },
              { value: 'preview', label: t('ed.preview') },
            ]}
          />
          <span className="ml-auto px-2 text-xs text-muted-foreground max-sm:hidden" aria-live="polite">
            {status}
          </span>
          <Button variant="ghost" size="sm" className="max-sm:hidden" onClick={() => onClose(draft)}>
            {t('common.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Applies an edit as one native change, so Ctrl+Z undoes it like typing. */
function applyTo(el: HTMLTextAreaElement, e: Edit) {
  el.focus()
  el.setSelectionRange(e.from, e.to)
  const native = e.text ? document.execCommand('insertText', false, e.text) : e.from === e.to || document.execCommand('delete')
  if (!native) {
    el.setRangeText(e.text, e.from, e.to, 'end')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  el.setSelectionRange(e.selStart, e.selEnd)
}
