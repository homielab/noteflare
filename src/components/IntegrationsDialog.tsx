import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { BookOpen, Check, Copy, KeyRound, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import type { ApiToken, TokenScope } from '../../shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { relativeTime as relative, shortDate } from '@/lib/time'

const DOCS_URL = 'https://github.com/homielab/noteflare/blob/main/docs/API.md'
const EXPIRY_OPTIONS = [
  { days: 30, key: 'int.days30' },
  { days: 90, key: 'int.days90' },
  { days: 365, key: 'int.year' },
  { days: null, key: 'int.never' },
] as const

export function IntegrationsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n()
  const [tokens, setTokens] = useState<ApiToken[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const apiUrl = `${location.origin}/api/v1`

  useEffect(() => {
    if (!open) return
    setCreated(null)
    setLoadError(false)
    api
      .listTokens()
      .then(setTokens)
      .catch(() => setLoadError(true))
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('int.title')}</DialogTitle>
          <DialogDescription>{t('int.body')}</DialogDescription>
        </DialogHeader>

        <Section title={t('int.apiAddress')}>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-sm">{apiUrl}</code>
            <CopyButton value={apiUrl} />
          </div>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 self-start py-1 text-sm text-link underline-offset-4 hover:underline [@media(pointer:coarse)]:py-2.5"
          >
            <BookOpen className="size-4" /> {t('int.docs')}
          </a>
        </Section>

        {created ? (
          <Section title={t('int.newToken')}>
            <div className="rounded-xl border-2 border-dashed border-primary/60 bg-surface p-3">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 font-mono text-sm break-all select-all">{created}</code>
                <CopyButton value={created} />
              </div>
              <p className="mt-2 flex gap-2 text-sm text-muted-foreground">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-link" />
                {t('int.created')}
              </p>
            </div>
            <Button className="mt-3" variant="outline" onClick={() => setCreated(null)}>
              {t('int.done')}
            </Button>
          </Section>
        ) : (
          <CreateTokenForm
            disabled={loadError}
            onCreated={(token, info) => {
              setCreated(token)
              setTokens((cur) => [info, ...(cur ?? [])])
            }}
          />
        )}

        <Section title={t('int.tokens')}>
          {loadError ? (
            <p className="text-sm text-destructive">{t('int.loadFailed')}</p>
          ) : !tokens ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : !tokens.length ? (
            <p className="text-sm text-muted-foreground">{t('int.none')}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {tokens.map((tok) => (
                <TokenRow
                  key={tok.id}
                  token={tok}
                  onRevoked={() => setTokens((cur) => cur?.filter((x) => x.id !== tok.id) ?? null)}
                />
              ))}
            </ul>
          )}
        </Section>
      </DialogContent>
    </Dialog>
  )
}

function CreateTokenForm({ disabled, onCreated }: { disabled: boolean; onCreated: (token: string, info: ApiToken) => void }) {
  const { t } = useI18n()
  const nameId = useId()
  const expiryId = useId()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<TokenScope>('read')
  const [expiry, setExpiry] = useState<string>('90')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    try {
      const res = await api.createToken({ name: name.trim(), scope, expiresInDays: expiry === 'never' ? null : Number(expiry) })
      setName('')
      onCreated(res.token, res.info)
    } catch {
      toast.error(t('int.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={t('int.newToken')}>
      <form onSubmit={submit} className="grid gap-3">
        <div className="grid gap-1.5">
          <label htmlFor={nameId} className="text-sm font-medium">
            {t('int.name')}
          </label>
          <Input id={nameId} value={name} maxLength={60} enterKeyHint="done" placeholder={t('int.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">{t('int.access')}</legend>
            <div className="flex rounded-md bg-muted p-0.5 text-sm" role="radiogroup">
              {(['read', 'write'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={scope === s}
                  onClick={() => setScope(s)}
                  className={cn(
                    'flex-1 rounded px-2.5 py-1.5 [@media(pointer:coarse)]:py-2.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    scope === s ? 'bg-surface font-medium shadow-sm' : 'text-muted-foreground',
                  )}
                >
                  {s === 'read' ? t('int.read') : t('int.write')}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-1.5">
            <label htmlFor={expiryId} className="text-sm font-medium">
              {t('int.expires')}
            </label>
            <select
              id={expiryId}
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.key} value={o.days ?? 'never'}>
                  {t(o.key)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button type="submit" disabled={busy || disabled || !name.trim()} className="justify-self-start">
          <KeyRound /> {busy ? t('int.creating') : t('int.create')}
        </Button>
      </form>
    </Section>
  )
}

function TokenRow({ token, onRevoked }: { token: ApiToken; onRevoked: () => void }) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  const expired = token.expiresAt !== null && token.expiresAt <= Date.now()

  useEffect(() => {
    if (!confirming) return
    const timer = window.setTimeout(() => setConfirming(false), 3000)
    return () => window.clearTimeout(timer)
  }, [confirming])

  const revoke = async () => {
    if (!confirming) return setConfirming(true)
    try {
      await api.revokeToken(token.id)
      onRevoked()
      toast(t('int.revoked'))
    } catch {
      toast.error(t('int.loadFailed'))
    }
  }

  const meta = [
    `${token.prefix}…`,
    token.scope === 'write' ? t('int.write') : t('int.read'),
    token.lastUsedAt ? t('int.lastUsed', { when: relative(token.lastUsedAt) }) : t('int.neverUsed'),
    expired ? t('int.expired') : token.expiresAt ? t('int.expiresOn', { date: shortDate(token.expiresAt) }) : t('int.noExpiry'),
  ]

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className={cn('truncate font-medium', expired && 'text-muted-foreground line-through')}>{token.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          <span className="font-mono">{meta[0]}</span> · {meta.slice(1).join(' · ')}
        </p>
      </div>
      <Button variant={confirming ? 'destructive' : 'ghost'} size="sm" onClick={() => void revoke()}>
        {confirming ? t('int.revokeConfirm') : t('int.revoke')}
      </Button>
    </li>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function CopyButton({ value }: { value: string }) {
  const { t } = useI18n()
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={t('int.copy')}
      onClick={() =>
        navigator.clipboard.writeText(value).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }
    >
      {done ? <Check /> : <Copy />} {done ? t('int.copied') : t('int.copy')}
    </Button>
  )
}
