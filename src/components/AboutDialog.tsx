import { useState, type ReactNode } from 'react'
import { ArrowUpRight, Bug, CheckCircle2, CircleAlert, Code, Coffee, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Segmented } from '@/components/ui/segmented'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { relativeTime, shortDate } from '@/lib/time'
import {
  APP_VERSION,
  CHANGELOG,
  DONATE_URL,
  ISSUES_URL,
  REPO_URL,
  UPDATE_GUIDE_URL,
  type UpdateState,
} from '@/lib/updates'
import { NoteMarkdown } from './NoteMarkdown'

export type AboutTab = 'updates' | 'changelog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  tab: AboutTab
  onTabChange: (tab: AboutTab) => void
  updates: UpdateState
  onCheck: () => void
}

export function AboutDialog({ open, onOpenChange, tab, onTabChange, updates, onCheck }: Props) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(42rem,calc(var(--vvh,100dvh)-2rem))] max-w-xl grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-5 overflow-hidden">
        <div className="flex items-center gap-3.5 pr-6">
          <img src="/favicon.svg" alt="" className="size-12 shrink-0" />
          <div className="min-w-0">
            <DialogTitle className="flex flex-wrap items-baseline gap-x-2">
              NoteFlare
              <span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 font-mono text-xs font-normal">v{APP_VERSION}</span>
            </DialogTitle>
            <DialogDescription className="mt-1">{t('about.tagline')}</DialogDescription>
          </div>
        </div>

        <Segmented
          label={t('about.title')}
          value={tab}
          onChange={onTabChange}
          options={[
            { value: 'updates', label: t('about.tabUpdates') },
            { value: 'changelog', label: t('about.tabChangelog') },
          ]}
        />

        <div key={tab} className="-mx-6 min-h-0 overflow-y-auto px-6 animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
          {tab === 'updates' ? <UpdateStatus state={updates} onCheck={onCheck} /> : <Changelog />}
        </div>

        <footer className="-mx-6 -mb-6 grid gap-3 border-t bg-foreground/[0.025] px-6 py-4">
          <a
            href={DONATE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-3 rounded-xl border bg-surface p-3 outline-none transition-[border-color,box-shadow,transform] duration-200 ease-[var(--ease-out)] hover:-translate-y-px hover:border-primary/50 hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
              <Coffee className="size-5 transition-transform duration-300 ease-[var(--ease-spring)] group-hover:-rotate-12" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t('about.donate')}</span>
              <span className="block text-xs text-muted-foreground">{t('about.donateBody')}</span>
            </span>
            <ArrowUpRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
          <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <ExtLink href={REPO_URL} icon={<Code className="size-4" />}>{t('about.source')}</ExtLink>
            <ExtLink href={ISSUES_URL} icon={<Bug className="size-4" />}>{t('about.report')}</ExtLink>
            <span className="text-muted-foreground">{t('about.license')}</span>
          </nav>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function UpdateStatus({ state, onCheck }: { state: UpdateState; onCheck: () => void }) {
  const { t } = useI18n()
  const checking = state.status === 'checking' || state.status === 'idle'
  const info = state.status === 'done' ? state.info : null

  let icon = <Loader2 className="size-5 animate-spin text-muted-foreground" />
  let title = t('up.checking')
  let body: string | null = null
  let tone = 'neutral'
  if (state.status === 'error') {
    icon = <CircleAlert className="size-5 text-muted-foreground" />
    title = t('up.errorTitle')
    body = t('up.error')
  } else if (info && !info.checkEnabled) {
    icon = <CircleAlert className="size-5 text-muted-foreground" />
    title = t('up.disabledTitle')
    body = t('up.disabled')
  } else if (info?.updateAvailable && info.latest) {
    icon = <Sparkles className="size-5 text-primary" />
    title = t('up.available', { v: info.latest.version })
    body = t('up.availableBody', { current: APP_VERSION })
    tone = 'accent'
  } else if (info?.latest) {
    icon = <CheckCircle2 className="size-5 text-success" />
    title = t('up.latest')
    body = t('up.latestBody', { v: APP_VERSION })
  } else if (info) {
    icon = <CircleAlert className="size-5 text-muted-foreground" />
    title = t('up.noReleases')
    body = t('up.noReleasesBody')
  }

  return (
    <div className="grid gap-4">
      <div
        aria-live="polite"
        className={cn(
          'flex gap-3 rounded-xl border p-4 transition-colors duration-300',
          tone === 'accent' && 'border-primary/40 bg-primary/[0.06]',
        )}
      >
        <span key={title} className="mt-0.5 animate-in zoom-in-50 fade-in-0 duration-300 ease-[var(--ease-spring)]">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          {body && <p className="mt-0.5 text-sm text-muted-foreground">{body}</p>}
          {info?.checkedAt && !checking && (
            <p className="mt-1 text-xs text-muted-foreground">{t('up.checked', { when: relativeTime(info.checkedAt) })}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {info?.updateAvailable && info.latest && (
              <>
                <Button size="sm" asChild>
                  <a href={UPDATE_GUIDE_URL} target="_blank" rel="noopener noreferrer">
                    {t('up.howTo')}
                  </a>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={info.latest.url} target="_blank" rel="noopener noreferrer">
                    {t('up.viewRelease')} <ArrowUpRight />
                  </a>
                </Button>
              </>
            )}
            {(!info || info.checkEnabled) && (
              <Button size="sm" variant="ghost" disabled={checking} onClick={onCheck}>
                <RefreshCw className={cn(checking && 'animate-spin')} /> {t('up.checkAgain')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {info?.updateAvailable && info.latest?.notes && (
        <section className="rounded-xl border p-4">
          <h3 className="mb-2 flex items-baseline justify-between gap-2 text-sm font-semibold">
            {info.latest.name}
            {info.latest.publishedAt && (
              <span className="text-xs font-normal text-muted-foreground">{shortDate(info.latest.publishedAt)}</span>
            )}
          </h3>
          <NoteMarkdown source={info.latest.notes} className="changelog" images={false} />
        </section>
      )}
    </div>
  )
}

function Changelog() {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const shown = all ? CHANGELOG : CHANGELOG.slice(0, 3)
  if (!CHANGELOG.length) return <p className="text-sm text-muted-foreground">{t('about.noChangelog')}</p>
  return (
    <ol className="relative grid gap-6 border-l pl-5">
      {shown.map((r, i) => (
        <li
          key={r.version}
          className="relative animate-in fade-in-0 slide-in-from-left-1 fill-mode-both duration-300"
          style={{ animationDelay: `${Math.min(i, 6) * 50}ms` }}
        >
          <span
            aria-hidden
            className={cn(
              'absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full ring-4 ring-background',
              r.version === APP_VERSION ? 'bg-primary' : 'bg-muted-foreground/40',
            )}
          />
          <h3 className="flex flex-wrap items-baseline gap-x-2 font-semibold">
            {r.version === 'Unreleased' ? t('about.unreleased') : `v${r.version}`}
            {r.version === APP_VERSION && (
              <span className="rounded-full bg-primary/12 px-2 py-0.5 text-xs font-medium text-link">{t('about.current')}</span>
            )}
            {r.date && <span className="text-xs font-normal text-muted-foreground">{shortDate(r.date)}</span>}
          </h3>
          <NoteMarkdown source={r.body} className="changelog mt-1.5" />
        </li>
      ))}
      {!all && CHANGELOG.length > shown.length && (
        <li>
          <Button variant="ghost" size="sm" className="-ml-3" onClick={() => setAll(true)}>
            {t('about.olderReleases', { n: CHANGELOG.length - shown.length })}
          </Button>
        </li>
      )}
    </ol>
  )
}

function ExtLink({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 py-1 text-muted-foreground underline-offset-4 [@media(pointer:coarse)]:py-2.5 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {icon}
      {children}
    </a>
  )
}
