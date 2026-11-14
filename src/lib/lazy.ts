import { preloadKdf } from './crypto'

/** The notebook (Markdown, editor, dialogs) ships in its own file, after the lock screen. */
export const loadNotebook = () => import('@/components/Notebook')

/**
 * Fetch what unlocking needs while the lock screen waits for the passphrase:
 * the notebook code and the Argon2id key-derivation code.
 */
export function preloadAfterLockScreen() {
  const go = () => {
    void loadNotebook().catch(() => {})
    void preloadKdf().catch(() => {})
  }
  if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 1500 })
  else setTimeout(go, 300)
}
