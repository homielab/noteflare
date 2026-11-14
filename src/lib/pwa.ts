import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { t } from '../i18n'

/** Chromium's install prompt event (not in the DOM typings yet). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let installEvent: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((fn) => fn())

export const isStandalone = () =>
  typeof matchMedia === 'function' &&
  (matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true)

/** Register the service worker and wire up install/update events. Production builds only. */
export function setupPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // offer it from the account menu instead of the browser's mini-infobar
    installEvent = e as BeforeInstallPromptEvent
    emit()
  })
  window.addEventListener('appinstalled', () => {
    installEvent = null
    emit()
  })

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  let hadController = !!navigator.serviceWorker.controller
  let updateRequested = false
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const first = !hadController
    hadController = true
    // The user chose Reload on an update: the new version is in control, load it.
    if (updateRequested) {
      if (!reloading) (reloading = true), location.reload()
      return
    }
    // The first install took control: the app shell is now saved on this device.
    if (first && !localFlag('noteflare:offlineReady')) toast(t('pwa.offlineReady'), { duration: 6000 })
  })

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js')
      // A new version that finished installing while the app is open waits for the user.
      const offer = (worker: ServiceWorker) =>
        toast(t('pwa.updateReady'), {
          duration: Infinity,
          action: {
            label: t('pwa.reload'),
            onClick: () => {
              updateRequested = true
              worker.postMessage('SKIP_WAITING')
            },
          },
        })
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting)
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker)
        })
      })
      // Long-lived installed apps: look for a new version when the app comes back to the front.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update().catch(() => {})
      })
    } catch (err) {
      console.warn('Service worker registration failed', err)
    }
  })
}

/** True the first time it's called for a key on this device, false afterwards. */
function localFlag(key: string) {
  try {
    if (localStorage.getItem(key)) return true
    localStorage.setItem(key, '1')
  } catch {
    /* private mode: just show it */
  }
  return false
}

/** Ask the browser not to evict the offline copy under storage pressure. */
export function keepOfflineCopy() {
  void navigator.storage?.persist?.().catch(() => {})
}

/** iPhone/iPad Safari (including iPadOS, which reports itself as a Mac). */
export const isIos = () =>
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

export function useInstallPrompt() {
  const canInstall = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => !!installEvent && !isStandalone(),
  )
  const install = async () => {
    if (!installEvent) return
    await installEvent.prompt()
    await installEvent.userChoice.catch(() => null)
    installEvent = null
    emit()
  }
  // iOS never fires beforeinstallprompt; offer the Add to Home Screen steps instead.
  const needsIosHelp = !canInstall && isIos() && !isStandalone()
  return { canInstall, install, needsIosHelp }
}
