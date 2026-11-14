import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { VaultRecord } from '../../shared/types'
import { api, ApiError } from './api'
import { localStore } from './sync/localStore'
import { keepOfflineCopy } from './pwa'
import { transition } from './motion'
import { createVault, rewrapVault, unlockWithPassphrase, unlockWithRecovery } from './crypto'

const IDLE_LOCK_MS = 15 * 60 * 1000

type Status = 'loading' | 'unauthorized' | 'error' | 'offline-empty' | 'setup' | 'locked' | 'unlocked'

interface VaultState {
  status: Status
  email: string | null
  /** Started without reaching the server; running from the copy on this device. */
  offline: boolean
  dek: CryptoKey | null
  /** Create a vault and return the recovery code for the user to store. */
  setup(passphrase: string): Promise<string>
  /** Call once the user confirms they saved the recovery code. */
  finishSetup(): void
  unlock(passphrase: string): Promise<void>
  recover(code: string, newPassphrase: string): Promise<void>
  changePassphrase(current: string, next: string): Promise<void>
  lock(): void
  /** Sign out of Cloudflare Access and remove the copy stored on this device. */
  signOut(): Promise<void>
}

const VaultContext = createContext<VaultState | null>(null)

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [email, setEmail] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [dek, setDek] = useState<CryptoKey | null>(null)
  const record = useRef<VaultRecord | null>(null)
  const pendingDek = useRef<CryptoKey | null>(null)

  useEffect(() => {
    ;(async () => {
      const cached = await localStore.getMeta()
      try {
        const me = await api.me()
        // Another account signed in on this browser: its cache must not mix with ours.
        if (cached?.email && cached.email !== me.email) await localStore.clear()
        await localStore.setMeta({ email: me.email, hasVault: me.hasVault })
        setEmail(me.email)
        if (!me.hasVault) return setStatus('setup')
        record.current = await api.getVault()
        await localStore.setVault(record.current)
        setStatus('locked')
      } catch (e) {
        if (e instanceof ApiError) return setStatus(e.status === 401 ? 'unauthorized' : 'error')
        // No connection: unlock from the wrapped keys kept on this device.
        const vault = await localStore.getVault()
        if (cached?.email && vault) {
          record.current = vault
          setEmail(cached.email)
          setOffline(true)
          setStatus('locked')
        } else {
          setStatus('offline-empty')
        }
      }
    })()
  }, [])

  const lock = useCallback(() => {
    setDek(null)
    pendingDek.current = null
    setStatus((s) => (s === 'unlocked' ? 'locked' : s))
  }, [])

  // Auto-lock when idle.
  useEffect(() => {
    if (status !== 'unlocked') return
    let timer = window.setTimeout(lock, IDLE_LOCK_MS)
    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(lock, IDLE_LOCK_MS)
    }
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    return () => {
      window.clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, reset))
    }
  }, [status, lock])

  const setup = useCallback(async (passphrase: string) => {
    const created = await createVault(passphrase)
    const { version } = await api.putVault(created.record)
    record.current = { ...created.record, version }
    await localStore.setVault(record.current)
    await localStore.setMeta({ hasVault: true })
    keepOfflineCopy()
    pendingDek.current = created.dek
    return created.recoveryCode
  }, [])

  const finishSetup = useCallback(() => {
    if (!pendingDek.current) return
    const key = pendingDek.current
    pendingDek.current = null
    transition(() => {
      setDek(key)
      setStatus('unlocked')
    })
  }, [])

  const unlock = useCallback(async (passphrase: string) => {
    if (!record.current) record.current = await api.getVault()
    const key = await unlockWithPassphrase(record.current, passphrase)
    keepOfflineCopy()
    transition(() => {
      setDek(key)
      setStatus('unlocked')
    })
  }, [])

  const saveRewrap = useCallback(
    async (secret: { passphrase: string } | { recoveryCode: string }, next: string) => {
      record.current = await api.getVault() // always start from the latest copy before overwriting
      const res = await rewrapVault(record.current, secret, next)
      const { version } = await api.putVault(res.record)
      record.current = { ...res.record, version }
      await localStore.setVault(record.current)
      return res.dek
    },
    [],
  )

  const recover = useCallback(
    async (code: string, newPassphrase: string) => {
      if (!record.current) record.current = await api.getVault()
      await unlockWithRecovery(record.current, code) // check the code first
      const key = await saveRewrap({ recoveryCode: code }, newPassphrase)
      transition(() => {
        setDek(key)
        setStatus('unlocked')
      })
    },
    [saveRewrap],
  )

  const changePassphrase = useCallback(
    async (current: string, next: string) => {
      setDek(await saveRewrap({ passphrase: current }, next))
    },
    [saveRewrap],
  )

  const signOut = useCallback(async () => {
    setDek(null)
    await localStore.clear()
    location.href = '/cdn-cgi/access/logout'
  }, [])

  return (
    <VaultContext.Provider
      value={{ status, email, offline, dek, setup, finishSetup, unlock, recover, changePassphrase, lock, signOut }}
    >
      {children}
    </VaultContext.Provider>
  )
}

export function useVault() {
  const ctx = useContext(VaultContext)
  if (!ctx) throw new Error('useVault must be used inside <VaultProvider>')
  return ctx
}
