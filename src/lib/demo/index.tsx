/** Demo build only: the in-browser backend, the banner and the reset. */
import { detectLang, useI18n } from '@/i18n'
import { localStore } from '../sync/localStore'
import { blobCache } from '../blobCache'
import { createDemoServer } from './server'
import { bannerText, DEMO_PASSPHRASE, DEPLOY_GUIDE_URL } from './content'

export { DEMO_PASSPHRASE }

const currentLang = () => {
  try {
    return localStorage.getItem('lang') ?? detectLang(navigator.languages ?? [navigator.language])
  } catch {
    return 'en'
  }
}

export const demoServer = createDemoServer(undefined, currentLang)

export async function resetDemo() {
  await Promise.allSettled([demoServer.reset(), localStore.clear(), blobCache.clear()])
  location.reload()
}

export function DemoBanner() {
  const { lang } = useI18n()
  const tx = bannerText(lang)
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b bg-muted px-4 py-1.5 text-center text-xs text-muted-foreground">
      <span>{tx.notice}</span>
      <span>
        {tx.passphrase}: <code className="rounded bg-background px-1 py-0.5 font-mono text-foreground">{DEMO_PASSPHRASE}</code>
      </span>
      <a className="font-medium text-link underline" href={DEPLOY_GUIDE_URL} target="_blank" rel="noopener">
        {tx.deploy}
      </a>
      <button type="button" className="font-medium text-link underline" onClick={() => window.confirm(tx.resetConfirm) && void resetDemo()}>
        {tx.reset}
      </button>
    </div>
  )
}
