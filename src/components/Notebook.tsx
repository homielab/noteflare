import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Archive, Check, Coffee, Download, FileInput, Fingerprint, FileUp, FolderUp, HardDriveDownload, Images, Info, Keyboard, KeyRound, Languages, LayoutGrid, Lock, LogOut, Moon, Pencil, Plug, Plus, RefreshCw, Rows3, Search, SquareCheckBig, StickyNote, Sun, Tag, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useVault } from '@/lib/vault'
import { copyNote, emptyNote, isEmptyNote, useNotes, type Note, type NotePatch } from '@/lib/notes'
import { prefersReducedMotion, transition, VT_CLASS, vtName } from '@/lib/motion'
import { LANGS, useI18n } from '@/i18n'
import { useTheme } from '@/hooks/useTheme'
import { useInstallPrompt } from '@/lib/pwa'
import { NoteCard, type ReorderHandlers } from './NoteCard'
import { cardProps, MAX_REVEAL, stableHandlers, type BoardState, type CardHandlers } from '@/lib/cardProps'
import { neighbourId, reorderPosition } from '@/lib/reorder'
import { NoteEditor } from './NoteEditor'
import { LabelMenu } from './LabelMenu'
import { bulkLabelChanges, commonLabels, renameLabelChanges, resolveLabel, restoreLabelChanges, undoLabelChanges } from '@/lib/bulkLabels'
import { RenameLabelDialog } from './RenameLabelDialog'
import { ChangePassphraseDialog } from './ChangePassphraseDialog'
import { PasskeysDialog } from './PasskeysDialog'
import { IntegrationsDialog } from './IntegrationsDialog'
import { BackupDialog } from './BackupDialog'
import { AttachmentsContext, clearAttachments, deleteAttachments, unusedAttachments, uploadAttachment } from '@/lib/attachments'
import { SaveIndicator, useSyncLabel } from './SaveIndicator'
import { AboutDialog, type AboutTab } from './AboutDialog'
import { ShortcutsDialog } from './ShortcutsDialog'
import { InstallHelpDialog } from './InstallHelpDialog'
import { DONATE_URL, takeNewReleases, useUpdates } from '@/lib/updates'
import { onLaunch, type LaunchAction } from '@/lib/launch'
import { themeTransition } from '@/lib/motion'
import { ImportDropzone, type ImportHandle } from './ImportDropzone'
import { ImageLibrary } from './ImageLibrary'
import { scanLibrary } from '@/lib/library'

type View = { kind: 'notes' } | { kind: 'archive' } | { kind: 'trash' } | { kind: 'label'; label: string } | { kind: 'images' }

const byPosition = (a: Note, b: Note) => b.position - a.position
const sameView = (a: View, b: View) => a.kind === b.kind && (a.kind !== 'label' || a.label === (b as typeof a).label)
const LAYOUT_KEY = 'noteflare:layout'
type Layout = 'grid' | 'list'

function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

export function Notebook({ dek }: { dek: CryptoKey }) {
  const { t, lang, setLang } = useI18n()
  const { email, lock, signOut, attachments, passkeySupport } = useVault()
  const attachmentsState = useMemo(() => ({ dek, enabled: attachments }), [dek, attachments])
  // Decrypted images live only while the notebook is unlocked.
  useEffect(() => clearAttachments, [dek])
  const { canInstall, install, needsIosHelp } = useInstallPrompt()
  const [iosHelpOpen, setIosHelpOpen] = useState(false)
  const store = useNotes(dek)
  const { theme, setTheme } = useTheme()
  const [view, setView] = useState<View>({ kind: 'notes' })
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Note | null>(null)
  // Select mode: the ids picked so far; null when the board is in its normal mode.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null)
  // The note that just closed keeps the top layer while it settles back into the grid.
  const [focusId, setFocusId] = useState<string | null>(null)
  const [pwOpen, setPwOpen] = useState(false)
  const [pkOpen, setPkOpen] = useState(false)
  const [intOpen, setIntOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [aboutTab, setAboutTab] = useState<AboutTab>('updates')
  const [keysOpen, setKeysOpen] = useState(false)
  const [layout, setLayoutState] = useState<Layout>(readLayout)
  // The grid follows the search box after a short pause, so results glide into place instead of flickering per keystroke.
  const [appliedQuery, setAppliedQuery] = useState('')
  const updates = useUpdates()
  const [revealing, setRevealing] = useState(() => !prefersReducedMotion())
  const searchRef = useRef<HTMLInputElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  /** The two lists as displayed, for drag-and-drop reordering. */
  const sectionsRef = useRef<{ pinned: Note[]; others: Note[] }>({ pinned: [], others: [] })
  const byIdRef = useRef(store.byId)

  useEffect(() => {
    if (query === appliedQuery) return
    const timer = window.setTimeout(() => transition(() => setAppliedQuery(query)), query ? 160 : 0)
    return () => window.clearTimeout(timer)
  }, [query, appliedQuery])

  const setLayout = (l: Layout) => {
    transition(() => setLayoutState(l))
    try {
      localStorage.setItem(LAYOUT_KEY, l)
    } catch {
      /* per-device preference only */
    }
  }

  const openAbout = useCallback((tab: AboutTab) => {
    setAboutTab(tab)
    setAboutOpen(true)
  }, [])

  // After a new version is deployed, offer the release notes once.
  useEffect(() => {
    const fresh = takeNewReleases()
    if (!fresh.length) return
    toast(t('new.toast', { v: fresh[0].version }), {
      duration: 10000,
      action: { label: t('new.action'), onClick: () => openAbout('changelog') },
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the owner about a new release once per version; the menu keeps a badge after that.
  const latest = updates.state.status === 'done' ? updates.state.info.latest : null
  useEffect(() => {
    if (!updates.updateAvailable || !latest) return
    const key = 'noteflare:notifiedUpdate'
    try {
      if (localStorage.getItem(key) === latest.version) return
      localStorage.setItem(key, latest.version)
    } catch {
      return
    }
    toast(t('up.toast', { v: latest.version }), { action: { label: t('up.toastAction'), onClick: () => openAbout('updates') } })
  }, [updates.updateAvailable, latest, openAbout, t])
  const importer = useRef<ImportHandle>(null)

  // The decrypt animation runs once, right after unlocking.
  useEffect(() => {
    if (store.loading || !revealing) return
    const timer = window.setTimeout(() => setRevealing(false), MAX_REVEAL * 70 + 1300)
    return () => window.clearTimeout(timer)
  }, [store.loading, revealing])

  const labels = useMemo(
    () => [...new Set(store.notes.filter((n) => !n.trashedAt).flatMap((n) => n.labels))].sort((a, b) => a.localeCompare(b)),
    [store.notes],
  )

  const counts = useMemo(() => {
    const live = store.notes.filter((n) => !n.trashedAt)
    return {
      notes: live.filter((n) => !n.archived).length,
      archive: live.filter((n) => n.archived).length,
      trash: store.notes.length - live.length,
    }
  }, [store.notes])

  const library = useMemo(() => scanLibrary(store.notes), [store.notes])
  const showLibrary = attachments || library.images.length + library.files.length > 0

  const visible = useMemo(() => {
    const q = appliedQuery.trim().toLocaleLowerCase()
    return store.notes
      .filter((n) => {
        switch (view.kind) {
          case 'notes': return !n.trashedAt && !n.archived
          case 'archive': return !n.trashedAt && n.archived
          case 'trash': return !!n.trashedAt
          case 'label': return !n.trashedAt && n.labels.includes(view.label)
          case 'images': return false
        }
      })
      .filter((n) => !q || `${n.title}\n${n.body}\n${n.labels.join(' ')}`.toLocaleLowerCase().includes(q))
      .sort(byPosition)
  }, [store.notes, view, appliedQuery])

  const pinned = view.kind === 'trash' ? [] : visible.filter((n) => n.pinned)
  const others = view.kind === 'trash' ? visible : visible.filter((n) => !n.pinned)
  const ordered = [...pinned, ...others]
  sectionsRef.current = { pinned, others }
  byIdRef.current = store.byId
  const selecting = selected !== null && view.kind !== 'trash'
  // Only notes still shown count: a search or a sync may have removed some.
  const picked = selecting ? ordered.filter((n) => selected.has(n.id)) : []
  const canReorder = view.kind !== 'trash' && !selecting

  const newNote = () => {
    const n = emptyNote()
    if (view.kind === 'label') n.labels = [view.label]
    if (view.kind === 'archive') n.archived = true
    transition(() => setEditing(n), 'none')
  }

  // Shortcuts: "/" to search, "c" for a new note, "?" for the list of shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      // Escape in the selection bar's label menu closes the menu, not select mode.
      if (e.key === 'Escape' && selected && !editing && !el.closest('[role=menu]')) return setSelected(null)
      if (editing || el.closest('input, textarea, [contenteditable], [role=dialog], [role=menu]')) return
      if (e.key === '/') (e.preventDefault(), searchRef.current?.focus())
      if (e.key === 'c' && !selecting && !e.metaKey && !e.ctrlKey) (e.preventDefault(), newNote())
      if (e.key === '?') (e.preventDefault(), setKeysOpen(true))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const { update, upsert, flush, discard, destroy, importMany, status } = store
  const saveState = !status.online || status.authExpired ? 'local' : status.syncing || status.pending ? 'saving' : 'idle'

  // Launches from outside the app: the "New note" shortcut, something shared to NoteFlare,
  // or .md files opened with the installed app. They wait until the notes have loaded.
  const launchRef = useRef<(a: LaunchAction) => void>(() => {})
  launchRef.current = (a) => {
    if (a.kind === 'new') return newNote()
    if (a.kind === 'files') return importer.current?.importFiles(a.files)
    const n = { ...emptyNote(), title: a.title, body: a.text }
    upsert(n) // saved straight away, so nothing shared is lost if the app closes
    transition(() => setEditing(n), 'none')
  }
  useEffect(() => {
    if (store.loading) return
    return onLaunch((a) => launchRef.current(a))
  }, [store.loading])

  const handleSignOut = async () => {
    flush()
    if (status.pending && !window.confirm(t('nb.signOutUnsynced', { n: status.pending }))) return
    await signOut()
  }

  const syncLabel = useSyncLabel(status)
  /** Push what is waiting and ask the server for changes from other devices. */
  const syncNow = () => {
    flush()
    void store.sync({ reconcile: true })
  }

  // Navigating home re-runs the Cloudflare Access login; queued changes wait safely in the device cache.
  const signInAgain = () => {
    flush()
    location.assign('/')
  }
  const open = (id: string) => {
    const n = store.byId.get(id)
    // Nothing else moves when a note opens: only its card morphs into the editor.
    if (n) transition(() => setEditing(n), { id })
  }
  const openFromLibrary = (id: string) => {
    const n = store.byId.get(id)
    if (n) transition(() => setEditing(n), 'none')
  }

  const moveWithUndo = useCallback(
    (id: string, patch: NotePatch, message: string, undo: NotePatch) => {
      transition(() => update(id, patch, { immediate: true }))
      toast(message, { action: { label: t('common.undo'), onClick: () => transition(() => update(id, undo, { immediate: true })) } })
    },
    [update, t],
  )

  const change = useCallback(
    (id: string, patch: NotePatch, immediate?: boolean) => {
      if (patch.trashedAt) return moveWithUndo(id, patch, t('nb.movedToTrash'), { trashedAt: null })
      if (patch.archived === true) return moveWithUndo(id, patch, t('nb.archived'), { archived: false })
      const moves = 'pinned' in patch || 'archived' in patch || 'trashedAt' in patch
      if (moves) transition(() => update(id, patch, { immediate }))
      else update(id, patch, { immediate })
    },
    [update, moveWithUndo, t],
  )

  const deleteForever = (id: string) => {
    transition(() => {
      setEditing((e) => (e?.id === id ? null : e))
      // Images that only this note used go with it, thumbnails included.
      const unused = unusedAttachments(
        [store.byId.get(id)?.body ?? ''],
        store.notes.filter((n) => n.id !== id).map((n) => n.body),
      )
      void destroy(id).then(() => {
        toast(t('nb.deletedForever'))
        deleteAttachments(unused)
      })
    })
  }

  const copy = (note: Note) => {
    transition(() => void upsert(copyNote(note), { immediate: true }))
    toast(t('nb.copied'))
  }

  const [renaming, setRenaming] = useState<string | null>(null)
  /** Rename a label on every note (trashed ones too). An existing target merges. One toast undoes it. */
  const renameLabel = (from: string, typed: string) => {
    const to = resolveLabel(typed, labels, from)
    const merged = labels.includes(to)
    const changes = renameLabelChanges(store.notes, from, to)
    if (!changes.length) return
    transition(() => {
      for (const c of changes) update(c.id, { labels: c.labels }, { immediate: true })
      setView((v) => (v.kind === 'label' && v.label === from ? { kind: 'label', label: to } : v))
    })
    toast(merged ? t('labels.merged', { from, to }) : t('labels.renamed', { l: to }), {
      action: {
        label: t('common.undo'),
        onClick: () =>
          transition(() => {
            restoreLabelChanges(changes, (id) => byIdRef.current.get(id)).forEach((c) => update(c.id, { labels: c.labels }, { immediate: true }))
            setView((v) => (v.kind === 'label' && v.label === to && !merged ? { kind: 'label', label: from } : v))
          }),
      },
    })
  }
  /** Take a label off every note (the notes stay), after asking. One toast undoes it. */
  const deleteLabel = (label: string) => {
    const changes = bulkLabelChanges(store.notes, label, false)
    if (!changes.length) return
    if (!window.confirm(changes.length === 1 ? t('labels.deleteConfirmOne', { l: label }) : t('labels.deleteConfirm', { l: label, n: changes.length }))) return
    transition(() => {
      for (const c of changes) update(c.id, { labels: c.labels }, { immediate: true })
      setView((v) => (v.kind === 'label' && v.label === label ? { kind: 'notes' } : v))
    })
    toast(t('labels.deleted', { l: label }), {
      action: {
        label: t('common.undo'),
        onClick: () => undoLabelChanges(changes, (id) => byIdRef.current.get(id), label, false).forEach((c) => update(c.id, { labels: c.labels }, { immediate: true })),
      },
    })
  }

  const toggleSelected = useCallback((id: string) => {
    setSelected((cur) => {
      if (!cur) return cur
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])
  const allPicked = selecting && picked.length === ordered.length
  const selectAll = () => setSelected(allPicked ? new Set() : new Set(ordered.map((n) => n.id)))
  /** Move the picked notes to the trash, after asking. One toast undoes the whole batch. */
  const trashSelected = () => {
    const ids = picked.map((n) => n.id)
    if (!ids.length) return
    if (!window.confirm(ids.length === 1 ? t('nb.trashSelectedConfirmOne') : t('nb.trashSelectedConfirm', { n: ids.length }))) return
    const trashedAt = Date.now()
    transition(() => {
      for (const id of ids) update(id, { trashedAt }, { immediate: true })
      setSelected(null)
    })
    toast(ids.length === 1 ? t('nb.movedToTrash') : t('nb.movedManyToTrash', { n: ids.length }), {
      action: { label: t('common.undo'), onClick: () => transition(() => ids.forEach((id) => update(id, { trashedAt: null }, { immediate: true }))) },
    })
  }
  /** Add the label to every picked note, or take it off all of them when they all have it. One toast undoes the batch. */
  const labelSelected = (label: string) => {
    const add = !commonLabels(picked).includes(label)
    const changes = bulkLabelChanges(picked, label, add)
    if (!changes.length) return
    for (const c of changes) update(c.id, { labels: c.labels }, { immediate: true })
    toast(t(add ? 'nb.labelAdded' : 'nb.labelRemoved', { l: label }), {
      // Undo works on the notes as they are by then, so a label set after this batch is kept.
      action: {
        label: t('common.undo'),
        onClick: () => undoLabelChanges(changes, (id) => byIdRef.current.get(id), label, add).forEach((c) => update(c.id, { labels: c.labels }, { immediate: true })),
      },
    })
  }

  // Drag-and-drop reordering. A drop onto a card in the other section also pins or unpins.
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const dragRef = useRef<string | null>(null)
  const moveTo = useCallback(
    (id: string, targetId: string) => {
      const { pinned, others } = sectionsRef.current
      const toPinned = pinned.some((n) => n.id === targetId)
      const position = reorderPosition(toPinned ? pinned : others, id, targetId)
      if (position === null) return
      const wasPinned = pinned.some((n) => n.id === id)
      transition(() => update(id, wasPinned === toPinned ? { position } : { position, pinned: toPinned }, { immediate: true }))
    },
    [update],
  )
  const reorder = useMemo<ReorderHandlers>(
    () => ({
      onDragStart: (id) => {
        dragRef.current = id
        setDragId(id)
      },
      onDragOver: (id) => setOverId(id === dragRef.current ? null : id),
      onDrop: (id) => {
        const moved = dragRef.current
        dragRef.current = null
        setDragId(null)
        setOverId(null)
        if (moved) moveTo(moved, id)
      },
      onDragEnd: () => {
        dragRef.current = null
        setDragId(null)
        setOverId(null)
      },
      onMove: (id, delta) => {
        const { pinned, others } = sectionsRef.current
        const target = neighbourId(pinned.some((n) => n.id === id) ? pinned : others, id, delta)
        if (target) moveTo(id, target)
      },
    }),
    [moveTo],
  )

  // Cards are memoized and there may be hundreds: their handlers keep one identity for good,
  // so an edit to one note (a new `store.byId` per keystroke) re-renders only that note's card.
  const handlersRef = useRef<CardHandlers>(null as never)
  handlersRef.current = { onOpen: open, onChange: change, onDeleteForever: deleteForever, onCopy: copy, onSelect: toggleSelected }
  const [cardHandlers] = useState(() => stableHandlers(() => handlersRef.current))
  const board: BoardState = {
    editingId: editing?.id ?? null,
    focusId,
    dragId,
    overId,
    selected: selecting ? selected : null,
    reorder: canReorder ? reorder : undefined,
    revealing,
  }

  /** Delete everything in the trash forever, after asking. Images only those notes used go too. */
  const emptyTrash = async () => {
    const trashed = store.notes.filter((n) => n.trashedAt)
    if (!trashed.length) return
    if (!window.confirm(trashed.length === 1 ? t('nb.emptyTrashConfirmOne') : t('nb.emptyTrashConfirm', { n: trashed.length }))) return
    const gone = new Set(trashed.map((n) => n.id))
    const unused = unusedAttachments(
      trashed.map((n) => n.body),
      store.notes.filter((n) => !gone.has(n.id)).map((n) => n.body),
    )
    setEditing((e) => (e && gone.has(e.id) ? null : e))
    for (const n of trashed) await destroy(n.id)
    deleteAttachments(unused)
    toast(t('nb.trashEmptied'))
  }

  useEffect(() => {
    if (!focusId) return
    const timer = window.setTimeout(() => setFocusId(null), 700)
    return () => window.clearTimeout(timer)
  }, [focusId])

  const closeEditor = (n: Note) => {
    // Promote the card before the old state is captured, then close.
    flushSync(() => setFocusId(n.id))
    transition(() => setEditing(null))
    if (isEmptyNote(n) && n.version === 0) return discard(n.id)
    if (n.trashedAt && !n.archived)
      toast(t('nb.movedToTrash'), {
        action: { label: t('common.undo'), onClick: () => transition(() => update(n.id, { trashedAt: null }, { immediate: true })) },
      })
    flush(n.id)
  }

  const go = (v: View) => {
    if (sameView(v, view)) return
    setSelected(null)
    transition(() => setView(v))
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  // Keep the active filter chip in view when the row scrolls sideways (phones, many labels).
  useEffect(() => {
    const nav = navRef.current
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!nav || !active) return
    const left = active.offsetLeft - nav.clientWidth / 2 + active.offsetWidth / 2
    nav.scrollTo({ left, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [view])

  // Fade the edges of the filter row only where there is more to scroll to.
  const [edges, setEdges] = useState({ start: false, end: false })
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const update = () =>
      setEdges({ start: nav.scrollLeft > 4, end: nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4 })
    update()
    nav.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(nav)
    return () => (nav.removeEventListener('scroll', update), ro.disconnect())
  }, [labels.length])

  const isNewDraft = !!editing && editing.version === 0 && !store.byId.has(editing.id)

  return (
    <AttachmentsContext.Provider value={attachmentsState}>
    <TooltipProvider delayDuration={400}>
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur-md" style={{ viewTransitionName: 'site-header' }}>
        <div className="mx-auto flex h-16 max-w-[84rem] items-center gap-3 px-3 sm:px-6">
          <a
            href="/"
            className="flex shrink-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label="NoteFlare"
            onClick={(e) => {
              // Home, without reloading: a reload would drop the key and lock the notebook.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
              e.preventDefault()
              setQuery('')
              go({ kind: 'notes' })
              window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
            }}
          >
            <img src="/favicon.svg" alt="" className="size-8" />
            <span className="text-lg font-semibold tracking-tight max-sm:hidden">NoteFlare</span>
          </a>

          <label className="relative mx-auto flex max-w-xl flex-1 items-center">
            <span className="sr-only">{t('nb.searchLabel')}</span>
            <Search className="pointer-events-none absolute left-3.5 size-4 text-muted-foreground" />
            <input
              ref={searchRef}
              type="search"
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), e.currentTarget.blur())}
              placeholder={t('nb.searchPlaceholder')}
              className="h-10 w-full rounded-full bg-muted pr-9 pl-10 text-sm outline-none transition-[background-color,box-shadow] placeholder:text-muted-foreground focus:bg-surface focus:shadow-[0_0_0_1.5px_var(--ring)] [&::-webkit-search-cancel-button]:hidden"
            />
            {query ? (
              <button type="button" aria-label={t('nb.clearSearch')} className="absolute right-2.5 rounded-full p-1 text-muted-foreground hover:text-foreground" onClick={() => setQuery('')}>
                <X className="size-4" />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-3 rounded border px-1.5 font-mono text-[11px] text-muted-foreground max-sm:hidden">/</kbd>
            )}
          </label>

          <div className="flex items-center gap-0.5">
            <SaveIndicator status={status} onSignIn={signInAgain} onSync={syncNow} />
            <Tooltip label={layout === 'grid' ? t('nb.layoutList') : t('nb.layoutGrid')}>
              <Button
                variant="ghost"
                size="icon"
                className="max-md:hidden"
                aria-label={layout === 'grid' ? t('nb.layoutList') : t('nb.layoutGrid')}
                onClick={() => setLayout(layout === 'grid' ? 'list' : 'grid')}
              >
                <span key={layout} className="animate-in zoom-in-75 spin-in-45 fade-in-0 duration-300 ease-[var(--ease-spring)]">
                  {layout === 'grid' ? <Rows3 /> : <LayoutGrid />}
                </span>
              </Button>
            </Tooltip>
            <Tooltip label={theme === 'dark' ? t('nb.lightTheme') : t('nb.darkTheme')}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('nb.toggleTheme')}
                onClick={(e) => themeTransition(e.currentTarget, () => setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark'))}
              >
                <Sun className="hidden dark:block" />
                <Moon className="dark:hidden" />
              </Button>
            </Tooltip>
            <Tooltip label={t('nb.lockNow')}>
              <Button variant="ghost" size="icon" aria-label={t('nb.lockNow')} className="max-sm:hidden" onClick={() => transition(lock)}>
                <Lock />
              </Button>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={updates.updateAvailable ? `${t('nb.account')} · ${t('nb.updateReady')}` : t('nb.account')}
                  className="relative rounded-full"
                >
                  <span className="grid size-8 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                    {email?.[0]?.toUpperCase()}
                  </span>
                  {updates.updateAvailable && (
                    <span aria-hidden className="absolute top-0.5 right-0.5 size-2.5 rounded-full bg-link ring-2 ring-background animate-in zoom-in-0 duration-300 ease-[var(--ease-spring)]" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="truncate">{email}</DropdownMenuLabel>
                {/* The sync state in words: on a phone the header only has room for its icon. */}
                <DropdownMenuItem onSelect={syncNow} className="text-xs text-muted-foreground">
                  <RefreshCw /> <span className="truncate">{syncLabel}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => importer.current?.pickFolder()}>
                  <FolderUp /> {t('nb.importFolder')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => importer.current?.pickFiles()}>
                  <FileUp /> {t('nb.importFiles')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    toast(t('imp.keepHint'))
                    importer.current?.pickFolder()
                  }}
                >
                  <StickyNote /> {t('nb.importKeep')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    toast(t('imp.otherHint'))
                    importer.current?.pickFiles()
                  }}
                >
                  <FileInput /> {t('nb.importOther')}
                </DropdownMenuItem>
                {(canInstall || needsIosHelp) && (
                  <DropdownMenuItem onSelect={() => (canInstall ? void install() : setIosHelpOpen(true))}>
                    <Download /> {t('nb.install')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => (flush(), setBackupOpen(true))}>
                  <HardDriveDownload /> {t('nb.backup')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="flex items-center gap-2">
                  <Languages className="size-3.5" /> {t('nb.language')}
                </DropdownMenuLabel>
                {LANGS.map((l) => (
                  <DropdownMenuItem key={l.code} onSelect={() => setLang(l.code)} lang={l.code}>
                    <span className="grid size-4 place-items-center">{lang === l.code && <Check />}</span>
                    {l.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setIntOpen(true)}>
                  <Plug /> {t('nb.integrations')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPwOpen(true)}>
                  <KeyRound /> {t('nb.changePassphrase')}
                </DropdownMenuItem>
                {passkeySupport && (
                  <DropdownMenuItem onSelect={() => setPkOpen(true)}>
                    <Fingerprint /> {t('nb.passkeys')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setKeysOpen(true)} className="max-md:hidden">
                  <Keyboard /> {t('nb.shortcuts')}
                  <kbd className="ml-auto font-mono text-xs text-muted-foreground">?</kbd>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openAbout('updates')}>
                  <Info /> {t('nb.about')}
                  {updates.updateAvailable && (
                    <span className="ml-auto rounded-full bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-link">{t('nb.updateReady')}</span>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={DONATE_URL} target="_blank" rel="noopener noreferrer">
                    <Coffee /> {t('nb.support')}
                  </a>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => transition(lock)}>
                  <Lock /> {t('nb.lockNow')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleSignOut()}>
                  <LogOut /> {t('nb.signOut')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Notes and labels scroll sideways; Images, Archive and Trash stay put, so they are always in reach. */}
        <nav aria-label={t('nb.filters')} className="mx-auto flex max-w-[84rem] items-start gap-2 px-3 pb-3 sm:px-6">
          <div
            ref={navRef}
            className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]"
            style={{
              maskImage: `linear-gradient(to right, ${edges.start ? 'transparent, black 2.5rem' : 'black, black'}, ${edges.end ? 'black calc(100% - 2.5rem), transparent' : 'black, black'})`,
            }}
          >
          <ul className="flex w-max gap-2">
            <Chip active={view.kind === 'notes'} onClick={() => go({ kind: 'notes' })} count={counts.notes}>
              {t('nb.notes')}
            </Chip>
            {labels.map((l) => (
              <Chip key={l} active={view.kind === 'label' && view.label === l} onClick={() => go({ kind: 'label', label: l })} title={l}>
                <span className="block max-w-[14rem] truncate">#{l}</span>
              </Chip>
            ))}
          </ul>
          </div>
          <ul className="flex shrink-0 gap-1 sm:gap-2">
            {showLibrary && <Chip active={view.kind === 'images'} onClick={() => go({ kind: 'images' })} count={library.images.length} icon={<Images />} label={t('nb.images')} />}
            <Chip active={view.kind === 'archive'} onClick={() => go({ kind: 'archive' })} count={counts.archive} icon={<Archive />} label={t('nb.archive')} />
            <Chip active={view.kind === 'trash'} onClick={() => go({ kind: 'trash' })} count={counts.trash} icon={<Trash2 />} label={t('nb.trash')} />
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-[84rem] px-3 pt-6 pb-32 sm:px-6">
        {view.kind === 'trash' && visible.length > 0 && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="text-sm text-muted-foreground">{t('nb.trashNotice')}</p>
            <Button variant="outline" size="sm" onClick={() => void emptyTrash()}>
              <Trash2 /> {t('nb.emptyTrashButton')}
            </Button>
          </div>
        )}
        {appliedQuery.trim() && visible.length > 0 && (
          <p key={visible.length} role="status" className="mb-5 px-1 text-sm text-muted-foreground animate-in fade-in-0 duration-200">
            {visible.length === 1 ? t('nb.resultOne') : t('nb.results', { n: visible.length })}
          </p>
        )}

        {!selecting && view.kind !== 'trash' && !store.loading && visible.length > 0 && (
          <div className="mb-3 flex justify-end gap-1">
            {view.kind === 'label' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-muted-foreground">
                    <Tag /> {t('labels.edit')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setRenaming(view.label)}>
                    <Pencil /> {t('labels.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => deleteLabel(view.label)}>
                    <Trash2 /> {t('labels.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setSelected(new Set())}>
              <SquareCheckBig /> {t('nb.select')}
            </Button>
          </div>
        )}

        {store.loading ? (
          <Skeleton label={t('nb.decryptingNotes')} />
        ) : view.kind === 'images' ? (
          <ImageLibrary library={library} query={appliedQuery} onOpenNote={openFromLibrary} />
        ) : !visible.length ? (
          <Empty view={view} query={appliedQuery} onNew={newNote} />
        ) : (
          <>
            {pinned.length > 0 && (
              <Section label={t('nb.pinned')} layout={layout}>
                {pinned.map((n, i) => (
                  <NoteCard key={n.id} {...cardProps(n, i, board, cardHandlers)} />
                ))}
              </Section>
            )}
            {others.length > 0 && (
              <Section label={pinned.length ? t('nb.others') : undefined} layout={layout}>
                {others.map((n, i) => (
                  <NoteCard key={n.id} {...cardProps(n, pinned.length + i, board, cardHandlers)} />
                ))}
              </Section>
            )}
          </>
        )}
      </main>

      {selecting && (
        <div
          role="toolbar"
          aria-label={t('nb.selectionBar')}
          className="fixed inset-x-0 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-30 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-2xl border bg-background/95 p-1.5 shadow-lg backdrop-blur-md animate-in fade-in-0 slide-in-from-bottom-2 duration-200"
        >
          <Tooltip label={t('nb.selectCancel')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('nb.selectCancel')} onClick={() => setSelected(null)}>
              <X />
            </Button>
          </Tooltip>
          <span role="status" className="px-1 text-sm tabular-nums whitespace-nowrap">{t('nb.selectedCount', { n: picked.length })}</span>
          <Button variant="ghost" size="sm" onClick={selectAll}>
            {allPicked ? t('nb.selectNone') : t('nb.selectAll')}
          </Button>
          <LabelMenu value={commonLabels(picked)} allLabels={labels} onToggle={labelSelected} disabled={!picked.length} />
          <Button variant="outline" size="sm" disabled={!picked.length} onClick={trashSelected}>
            <Trash2 /> {t('nb.trashSelected')}
          </Button>
        </div>
      )}

      {view.kind !== 'trash' && !selecting && (
        <button
          type="button"
          onClick={newNote}
          aria-keyshortcuts="c"
          style={{ viewTransitionName: isNewDraft ? 'none' : 'composer', viewTransitionClass: VT_CLASS.fab }}
          className={cn(
            'group fixed right-[calc(1.25rem+env(safe-area-inset-right))] bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-30 flex h-14 items-center gap-2 rounded-2xl bg-primary pr-5 pl-4 font-medium text-primary-foreground outline-none sm:right-[calc(2rem+env(safe-area-inset-right))] sm:bottom-[calc(2rem+env(safe-area-inset-bottom))]',
            'shadow-[0_10px_30px_-10px_color-mix(in_oklab,var(--primary)_80%,transparent)] transition-[transform,box-shadow] duration-200 ease-[var(--ease-out)]',
            'hover:-translate-y-0.5 hover:shadow-[0_14px_34px_-10px_color-mix(in_oklab,var(--flare)_70%,transparent)] active:translate-y-0 active:scale-[0.97]',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50',
            isNewDraft && 'opacity-0',
            // Out of the way while typing on a phone (search box, dialogs).
            '[html[data-keyboard=open]_&]:pointer-events-none [html[data-keyboard=open]_&]:opacity-0',
          )}
        >
          <Plus className="size-5 transition-transform duration-300 ease-[var(--ease-spring)] group-hover:rotate-90" />
          {t('nb.newNote')}
        </button>
      )}

      <ImportDropzone
        ref={importer}
        enabled={!editing && !pwOpen && !pkOpen && !intOpen && !backupOpen && !aboutOpen && !keysOpen}
        images={{ enabled: attachments, upload: (file) => uploadAttachment(dek, file) }}
        onImport={importMany}
        onDone={() => {
          setQuery('')
          go({ kind: 'notes' })
        }}
      />

      <NoteEditor
        note={editing}
        transitionName={editing ? (isNewDraft ? 'composer' : vtName(editing.id)) : undefined}
        allLabels={labels}
        saveState={saveState}
        onSave={(n) => upsert(n)}
        onClose={closeEditor}
        onDeleteForever={deleteForever}
        onCopy={copy}
      />
      <RenameLabelDialog label={renaming} labels={labels} onClose={() => setRenaming(null)} onRename={renameLabel} />
      <ChangePassphraseDialog open={pwOpen} onOpenChange={setPwOpen} />
      <PasskeysDialog open={pkOpen} onOpenChange={setPkOpen} />
      <IntegrationsDialog open={intOpen} onOpenChange={setIntOpen} />
      <BackupDialog open={backupOpen} onOpenChange={setBackupOpen} dek={dek} notes={store.notes} onImport={(found) => importMany(found)} />
      <AboutDialog
        open={aboutOpen}
        onOpenChange={setAboutOpen}
        tab={aboutTab}
        onTabChange={setAboutTab}
        updates={updates.state}
        onCheck={() => void updates.check(true)}
      />
      <ShortcutsDialog open={keysOpen} onOpenChange={setKeysOpen} />
      <InstallHelpDialog open={iosHelpOpen} onOpenChange={setIosHelpOpen} />
    </div>
    </TooltipProvider>
    </AttachmentsContext.Provider>
  )
}

interface ChipProps {
  active: boolean
  onClick: () => void
  count?: number
  title?: string
  children?: ReactNode
  /** With an icon, the label is hidden on narrow screens (it stays the accessible name). */
  icon?: ReactNode
  label?: string
}

function Chip({ active, onClick, count, title, children, icon, label }: ChipProps) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        title={title ?? label}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        style={active ? { viewTransitionName: 'chip-active' } : undefined}
        className={cn(
          'relative flex h-9 items-center gap-2 rounded-full px-4 text-sm outline-none max-sm:px-3 focus-visible:ring-[3px] focus-visible:ring-ring/50 [@media(pointer:coarse)]:h-10',
          active ? 'font-medium text-primary-foreground' : 'text-foreground/75 hover:bg-accent hover:text-foreground',
        )}
      >
        {active && <span aria-hidden className="absolute inset-0 rounded-full bg-primary" />}
        {icon && <span className="relative [&_svg]:size-4">{icon}</span>}
        <span className={cn('relative', icon && 'max-sm:hidden')}>{children ?? label}</span>
        {!!count && <span className={cn('relative text-xs tabular-nums', active ? 'opacity-75' : 'text-muted-foreground')}>{count}</span>}
      </button>
    </li>
  )
}

function Section({ label, layout, children }: { label?: string; layout: Layout; children: ReactNode }) {
  return (
    <section className={cn('mb-8', layout === 'list' && 'mx-auto max-w-2xl')}>
      {label && <h2 className="mb-3 px-1 text-sm font-medium text-muted-foreground">{label}</h2>}
      <div className={layout === 'list' ? 'grid gap-3' : 'masonry'}>{children}</div>
    </section>
  )
}

/** Placeholder cards while notes decrypt, so the page doesn't jump when they arrive. */
function Skeleton({ label }: { label: string }) {
  const heights = [168, 112, 220, 136, 184, 120, 152, 200]
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="masonry" aria-hidden>
        {heights.map((h, i) => (
          <div key={i} className="skeleton rounded-2xl border" style={{ height: h, animationDelay: `${i * 90}ms` }} />
        ))}
      </div>
    </div>
  )
}

function Empty({ view, query, onNew }: { view: View; query: string; onNew: () => void }) {
  const { t } = useI18n()
  const text = query
    ? t('nb.emptySearch', { q: query })
    : view.kind === 'archive'
      ? t('nb.emptyArchive')
      : view.kind === 'trash'
        ? t('nb.emptyTrash')
        : view.kind === 'label'
          ? t('nb.emptyLabel')
          : t('nb.emptyNotes')
  return (
    <div className="mt-24 flex flex-col items-center gap-4 text-center">
      <p className="max-w-sm text-muted-foreground">{text}</p>
      {!query && view.kind === 'notes' && (
        <>
          <Button variant="outline" onClick={onNew}>
            <Plus /> {t('nb.writeFirst')}
          </Button>
          <p className="text-sm text-muted-foreground">{t('nb.orDrop')}</p>
        </>
      )}
    </div>
  )
}
