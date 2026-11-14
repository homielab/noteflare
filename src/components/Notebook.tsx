import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Check, Coffee, Download, FileUp, FolderUp, HardDriveDownload, Info, Keyboard, KeyRound, Languages, LayoutGrid, Lock, LogOut, Moon, Plug, Plus, Rows3, Search, StickyNote, Sun, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useVault } from '@/lib/vault'
import { emptyNote, isEmptyNote, useNotes, type Note, type NotePatch } from '@/lib/notes'
import { prefersReducedMotion, transition, VT_CLASS, vtName } from '@/lib/motion'
import { LANGS, useI18n } from '@/i18n'
import { useTheme } from '@/hooks/useTheme'
import { useInstallPrompt } from '@/lib/pwa'
import { NoteCard, type ReorderHandlers } from './NoteCard'
import { neighbourId, reorderPosition } from '@/lib/reorder'
import { NoteEditor } from './NoteEditor'
import { ChangePassphraseDialog } from './ChangePassphraseDialog'
import { IntegrationsDialog } from './IntegrationsDialog'
import { BackupDialog } from './BackupDialog'
import { SaveIndicator } from './SaveIndicator'
import { AboutDialog, type AboutTab } from './AboutDialog'
import { ShortcutsDialog } from './ShortcutsDialog'
import { InstallHelpDialog } from './InstallHelpDialog'
import { DONATE_URL, takeNewReleases, useUpdates } from '@/lib/updates'
import { onLaunch, type LaunchAction } from '@/lib/launch'
import { themeTransition } from '@/lib/motion'
import { ImportDropzone, type ImportHandle } from './ImportDropzone'

type View = { kind: 'notes' } | { kind: 'archive' } | { kind: 'trash' } | { kind: 'label'; label: string }

const byPosition = (a: Note, b: Note) => b.position - a.position
const sameView = (a: View, b: View) => a.kind === b.kind && (a.kind !== 'label' || a.label === (b as typeof a).label)
const MAX_REVEAL = 18
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
  const { email, lock, signOut } = useVault()
  const { canInstall, install, needsIosHelp } = useInstallPrompt()
  const [iosHelpOpen, setIosHelpOpen] = useState(false)
  const store = useNotes(dek)
  const { theme, setTheme } = useTheme()
  const [view, setView] = useState<View>({ kind: 'notes' })
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Note | null>(null)
  // The note that just closed keeps the top layer while it settles back into the grid.
  const [focusId, setFocusId] = useState<string | null>(null)
  const [pwOpen, setPwOpen] = useState(false)
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
  const navRef = useRef<HTMLElement>(null)
  /** The two lists as displayed, for drag-and-drop reordering. */
  const sectionsRef = useRef<{ pinned: Note[]; others: Note[] }>({ pinned: [], others: [] })

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

  const visible = useMemo(() => {
    const q = appliedQuery.trim().toLocaleLowerCase()
    return store.notes
      .filter((n) => {
        switch (view.kind) {
          case 'notes': return !n.trashedAt && !n.archived
          case 'archive': return !n.trashedAt && n.archived
          case 'trash': return !!n.trashedAt
          case 'label': return !n.trashedAt && n.labels.includes(view.label)
        }
      })
      .filter((n) => !q || `${n.title}\n${n.body}\n${n.labels.join(' ')}`.toLocaleLowerCase().includes(q))
      .sort(byPosition)
  }, [store.notes, view, appliedQuery])

  const pinned = view.kind === 'trash' ? [] : visible.filter((n) => n.pinned)
  const others = view.kind === 'trash' ? visible : visible.filter((n) => !n.pinned)
  const ordered = [...pinned, ...others]
  sectionsRef.current = { pinned, others }
  const canReorder = view.kind !== 'trash'
  const revealIndex = (id: string) => {
    if (!revealing) return undefined
    const i = ordered.findIndex((n) => n.id === id)
    return i >= 0 && i < MAX_REVEAL ? i : undefined
  }

  const newNote = () => {
    const n = emptyNote()
    if (view.kind === 'label') n.labels = [view.label]
    if (view.kind === 'archive') n.archived = true
    transition(() => setEditing(n))
  }

  // Shortcuts: "/" to search, "c" for a new note, "?" for the list of shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (editing || el.closest('input, textarea, [contenteditable], [role=dialog], [role=menu]')) return
      if (e.key === '/') (e.preventDefault(), searchRef.current?.focus())
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey) (e.preventDefault(), newNote())
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
    transition(() => setEditing(n))
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

  // Navigating home re-runs the Cloudflare Access login; queued changes wait safely in the device cache.
  const signInAgain = () => {
    flush()
    location.assign('/')
  }
  const open = useCallback(
    (id: string) => {
      const n = store.byId.get(id)
      if (n) transition(() => setEditing(n))
    },
    [store.byId],
  )

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

  const deleteForever = useCallback(
    (id: string) => {
      transition(() => {
        setEditing((e) => (e?.id === id ? null : e))
        void destroy(id).then(() => toast(t('nb.deletedForever')))
      })
    },
    [destroy, t],
  )

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
    <TooltipProvider delayDuration={400}>
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur-md" style={{ viewTransitionName: 'site-header' }}>
        <div className="mx-auto flex h-16 max-w-[84rem] items-center gap-3 px-3 sm:px-6">
          <a href="/" className="flex shrink-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label="NoteFlare">
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
            <SaveIndicator status={status} onSignIn={signInAgain} />
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

        <nav
          ref={navRef}
          aria-label={t('nb.filters')}
          className="mx-auto max-w-[84rem] overflow-x-auto px-3 pb-3 [scrollbar-width:none] sm:px-6"
          style={{
            maskImage: `linear-gradient(to right, ${edges.start ? 'transparent, black 2.5rem' : 'black, black'}, ${edges.end ? 'black calc(100% - 2.5rem), transparent' : 'black, black'})`,
          }}
        >
          <ul className="flex w-max gap-2">
            <Chip active={view.kind === 'notes'} onClick={() => go({ kind: 'notes' })} count={counts.notes}>
              {t('nb.notes')}
            </Chip>
            {labels.map((l) => (
              <Chip key={l} active={view.kind === 'label' && view.label === l} onClick={() => go({ kind: 'label', label: l })}>
                #{l}
              </Chip>
            ))}
            <Chip active={view.kind === 'archive'} onClick={() => go({ kind: 'archive' })} count={counts.archive}>
              {t('nb.archive')}
            </Chip>
            <Chip active={view.kind === 'trash'} onClick={() => go({ kind: 'trash' })} count={counts.trash}>
              {t('nb.trash')}
            </Chip>
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-[84rem] px-3 pt-6 pb-32 sm:px-6">
        {view.kind === 'trash' && visible.length > 0 && <p className="mb-6 text-sm text-muted-foreground">{t('nb.trashNotice')}</p>}
        {appliedQuery.trim() && visible.length > 0 && (
          <p key={visible.length} role="status" className="mb-5 px-1 text-sm text-muted-foreground animate-in fade-in-0 duration-200">
            {visible.length === 1 ? t('nb.resultOne') : t('nb.results', { n: visible.length })}
          </p>
        )}

        {store.loading ? (
          <Skeleton label={t('nb.decryptingNotes')} />
        ) : !visible.length ? (
          <Empty view={view} query={appliedQuery} onNew={newNote} />
        ) : (
          <>
            {pinned.length > 0 && (
              <Section label={t('nb.pinned')} layout={layout}>
                {pinned.map((n) => (
                  <NoteCard key={n.id} note={n} revealIndex={revealIndex(n.id)} lifted={editing?.id === n.id} focused={focusId === n.id} onOpen={open} onChange={change} onDeleteForever={deleteForever} reorder={canReorder ? reorder : undefined} dragging={dragId === n.id} dropTarget={overId === n.id} />
                ))}
              </Section>
            )}
            {others.length > 0 && (
              <Section label={pinned.length ? t('nb.others') : undefined} layout={layout}>
                {others.map((n) => (
                  <NoteCard key={n.id} note={n} revealIndex={revealIndex(n.id)} lifted={editing?.id === n.id} focused={focusId === n.id} onOpen={open} onChange={change} onDeleteForever={deleteForever} reorder={canReorder ? reorder : undefined} dragging={dragId === n.id} dropTarget={overId === n.id} />
                ))}
              </Section>
            )}
          </>
        )}
      </main>

      {view.kind !== 'trash' && (
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
        enabled={!editing && !pwOpen && !intOpen && !backupOpen && !aboutOpen && !keysOpen}
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
      />
      <ChangePassphraseDialog open={pwOpen} onOpenChange={setPwOpen} />
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
  )
}

function Chip({ active, onClick, count, children }: { active: boolean; onClick: () => void; count?: number; children: ReactNode }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        style={active ? { viewTransitionName: 'chip-active' } : undefined}
        className={cn(
          'relative flex h-9 items-center gap-2 rounded-full px-4 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [@media(pointer:coarse)]:h-10',
          active ? 'font-medium text-primary-foreground' : 'text-foreground/75 hover:bg-accent hover:text-foreground',
        )}
      >
        {active && <span aria-hidden className="absolute inset-0 rounded-full bg-primary" />}
        <span className="relative">{children}</span>
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
