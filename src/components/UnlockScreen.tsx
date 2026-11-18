import { maskEmail } from '@/lib/maskEmail'
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { CloudOff, Copy, Download, ExternalLink, Fingerprint, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useVault } from '@/lib/vault'
import { UnsafeKdfError, WrongSecretError } from '@/lib/crypto'
import { cipherNoise } from '@/lib/motion'
import { PasskeyCancelledError } from '@/lib/passkeys'
import { api, ApiError, type SetupInfo } from '@/lib/api'
import { preloadAfterLockScreen } from '@/lib/lazy'
import { t as translate, useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/en'

const MIN_PASSPHRASE = 10

/** The backdrop is a faint wall of ciphertext — exactly what the server sees. */
function CipherWall() {
  const text = useMemo(() => cipherNoise(9000), [])
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 overflow-hidden font-mono text-[13px] leading-[1.6] break-all text-foreground/[0.07] select-none [mask-image:radial-gradient(ellipse_at_center,transparent_22%,black_75%)]"
    >
      {text}
    </div>
  )
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="relative grid min-h-dvh place-items-center px-4 py-10">
      <CipherWall />
      <div className="relative w-full max-w-md animate-in fade-in-0 slide-in-from-bottom-2 duration-500">
        <div className="mb-8 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-lg font-semibold tracking-tight">NoteFlare</span>
        </div>
        {children}
      </div>
    </main>
  )
}

function Field({ label, hint, ...props }: { label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  const id = useId()
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input id={id} aria-describedby={hint ? `${id}-hint` : undefined} className="h-12 bg-surface text-base" {...props} />
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight">{children}</h1>
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  )
}

function messageOf(e: unknown) {
  if (e instanceof WrongSecretError) return translate('unlock.wrongSecret')
  if (e instanceof UnsafeKdfError) return translate('unlock.unsafeKdf')
  // fetch fails with a TypeError when the network is down; ApiError is the server answering with an error.
  if (e instanceof TypeError || e instanceof ApiError) return translate('unlock.networkError')
  return translate('unlock.unexpectedError')
}

export function UnlockScreen() {
  const { status } = useVault()
  useEffect(preloadAfterLockScreen, [])
  if (status === 'setup') return <SetupFlow />
  if (status === 'locked') return <LockedFlow />
  return null
}

// ------------------------------------------------------------------ access setup

/** A new deployment without a Cloudflare login yet: create it from here with an API token. */
export function AccessSetupScreen() {
  const { t } = useI18n()
  const [info, setInfo] = useState<SetupInfo | null>(null)
  const [token, setToken] = useState('')
  const [emails, setEmails] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    api
      .setupInfo()
      .then((i) => {
        setInfo(i)
        setEmails(i.emails ?? '')
      })
      .catch(() => setError(t('access.failed')))
  }, [t])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.setup(token, emails)
      setToken('')
      setDone(true)
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { error?: string; detail?: string } | null) : null
      const known = ['bad_request', 'invalid_token', 'not_owner', 'zero_trust', 'cloudflare', 'no_database', 'already_set_up']
      const message = body?.error && known.includes(body.error) ? t(`access.err.${body.error}` as MessageKey) : t('access.failed')
      setError(body?.detail ? `${message} (${body.detail})` : message)
    } finally {
      setBusy(false)
    }
  }

  if (done)
    return (
      <Frame>
        <ShieldCheck className="mb-4 size-10 text-flare" aria-hidden />
        <Heading>{t('access.doneTitle')}</Heading>
        <p className="mt-3 text-muted-foreground">{t('access.doneBody')}</p>
        <Button size="lg" className="mt-8 w-full" onClick={() => location.reload()}>
          {t('access.signIn')}
        </Button>
      </Frame>
    )

  return (
    <Frame>
      <Heading>{t('access.title')}</Heading>
      <p className="mt-3 text-muted-foreground">{t('access.body')}</p>
      <form onSubmit={submit} className="mt-8 grid gap-5">
        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('access.step1')}</p>
          <Button asChild variant="outline" size="lg" disabled={!info?.tokenUrl}>
            <a href={info?.tokenUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> {t('access.createToken')}
            </a>
          </Button>
          <p className="text-sm text-muted-foreground">{t('access.step1Hint')}</p>
        </div>
        <Field
          label={t('access.step2')}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('access.token')}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
        />
        <Field
          label={t('access.emails')}
          type="text"
          inputMode="email"
          autoComplete="email"
          hint={t('access.emailsHint')}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          required
        />
        {error && <ErrorText>{error}</ErrorText>}
        <Button size="lg" type="submit" disabled={busy || !info?.needed}>
          <ShieldCheck />
          {busy ? t('access.working') : t('access.submit')}
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted-foreground">
        <a className="text-link underline" href={t('gate.accessGuideUrl')} target="_blank" rel="noopener">
          {t('access.manual')}
        </a>
      </p>
    </Frame>
  )
}

// ------------------------------------------------------------------ setup

function SetupFlow() {
  const { t } = useI18n()
  const { email, setup, finishSetup } = useVault()
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (pass.length < MIN_PASSPHRASE) return setError(t('unlock.tooShort', { n: MIN_PASSPHRASE }))
    if (pass !== confirm) return setError(t('unlock.mismatch'))
    setBusy(true)
    setError(null)
    try {
      setCode(await setup(pass))
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  if (code) {
    const download = () => {
      const blob = new Blob([t('unlock.recoveryFile', { email: email ?? '', code })], { type: 'text/plain' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = t('unlock.recoveryFileName')
      a.click()
      URL.revokeObjectURL(a.href)
    }
    return (
      <Frame>
        <Heading>{t('unlock.recoveryTitle')}</Heading>
        <p className="mt-3 text-muted-foreground">{t('unlock.recoveryBody')}</p>
        <output className="mt-6 block rounded-xl border-2 border-dashed border-primary/60 bg-surface px-4 py-5 text-center font-mono text-lg tracking-wider break-all select-all">
          {code}
        </output>
        <div className="mt-3 flex gap-2">
          <Button variant="outline" onClick={() => navigator.clipboard.writeText(code).then(() => toast(t('unlock.copied')))}>
            <Copy /> {t('unlock.copy')}
          </Button>
          <Button variant="outline" onClick={download}>
            <Download /> {t('unlock.download')}
          </Button>
        </div>
        <label className="mt-6 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--primary)]"
          />
          {t('unlock.savedConfirm')}
        </label>
        <Button size="lg" className="mt-6 w-full" disabled={!saved} onClick={finishSetup}>
          {t('unlock.open')}
        </Button>
      </Frame>
    )
  }

  return (
    <Frame>
      <Heading>{t('unlock.setupTitle')}</Heading>
      <p className="mt-3 text-muted-foreground">{t('unlock.setupBody')}</p>
      <form onSubmit={submit} className="mt-8 grid gap-5">
        <Field
          label={t('unlock.passphrase')}
          type="password"
          autoComplete="new-password"
          autoFocus
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          hint={t('unlock.passphraseHint', { n: MIN_PASSPHRASE })}
        />
        <Field
          label={t('unlock.confirmPassphrase')}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {error && <ErrorText>{error}</ErrorText>}
        <Button size="lg" type="submit" disabled={busy}>
          <KeyRound />
          {busy ? t('unlock.creatingKey') : t('unlock.createKey')}
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted-foreground">{t('unlock.signedInAs', { email: email ?? '' })}</p>
    </Frame>
  )
}

// ------------------------------------------------------------------ locked

class InputError extends Error {}

function LockedFlow() {
  const { t } = useI18n()
  const { email, unlock, recover, offline, passkeys, passkeySupport, unlockWithPasskey } = useVault()
  const [mode, setMode] = useState<'pass' | 'recover'>('pass')
  const [pass, setPass] = useState('')
  const [code, setCode] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === 'pass') {
        if (!pass) throw new InputError(t('unlock.enterPassphrase'))
        await unlock(pass)
      } else {
        if (!code.trim()) throw new InputError(t('unlock.enterRecoveryCode'))
        if (next.length < MIN_PASSPHRASE) throw new InputError(t('unlock.newTooShort', { n: MIN_PASSPHRASE }))
        await recover(code, next)
      }
    } catch (err) {
      setError(err instanceof InputError ? err.message : messageOf(err))
      setBusy(false)
    }
  }

  const withPasskey = async () => {
    setBusy(true)
    setError(null)
    try {
      await unlockWithPasskey()
    } catch (err) {
      if (!(err instanceof PasskeyCancelledError)) setError(t('unlock.passkeyFailed'))
      setBusy(false)
    }
  }

  return (
    <Frame>
      <Heading>{mode === 'pass' ? t('unlock.lockedTitle') : t('unlock.recoverTitle')}</Heading>
      <p className="mt-3 text-muted-foreground">{mode === 'pass' ? t('unlock.lockedBody') : t('unlock.recoverBody')}</p>
      {offline && (
        <p className="mt-4 flex gap-2.5 rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
          <CloudOff className="mt-0.5 size-4 shrink-0" />
          {mode === 'pass' ? t('unlock.offlineHint') : t('unlock.recoverOffline')}
        </p>
      )}
      <form onSubmit={submit} className="mt-8 grid gap-5">
        {mode === 'pass' ? (
          <Field
            label={t('unlock.passphrase')}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        ) : (
          <>
            <Field
              label={t('unlock.recoveryCode')}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
              className="h-12 bg-surface font-mono text-base uppercase"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Field
              label={t('unlock.newPassphrase')}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </>
        )}
        {error && <ErrorText>{error}</ErrorText>}
        <Button size="lg" type="submit" disabled={busy}>
          <LockKeyhole />
          {busy ? t('unlock.decrypting') : mode === 'pass' ? t('unlock.unlock') : t('unlock.resetAndUnlock')}
        </Button>
        {mode === 'pass' && passkeySupport && passkeys.length > 0 && (
          <Button size="lg" type="button" variant="outline" disabled={busy} onClick={() => void withPasskey()}>
            <Fingerprint />
            {t('unlock.usePasskey')}
          </Button>
        )}
      </form>
      <div className="mt-6 flex items-center justify-between gap-4 text-sm">
        <span className="truncate text-muted-foreground">{email ? maskEmail(email) : null}</span>
        <button
          type="button"
          className="-my-2 shrink-0 py-2 text-link underline-offset-4 hover:underline [@media(pointer:coarse)]:-my-3 [@media(pointer:coarse)]:py-3"
          onClick={() => {
            setMode(mode === 'pass' ? 'recover' : 'pass')
            setError(null)
          }}
        >
          {mode === 'pass' ? t('unlock.forgot') : t('unlock.usePassphrase')}
        </button>
      </div>
    </Frame>
  )
}
