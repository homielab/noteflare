import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { api } from './api'
import { localStore } from './sync/localStore'
import { NoteSync } from './sync/engine'
import { t } from '../i18n'

export { emptyNote, isEmptyNote, toggleTask, type Note, type NotePatch } from './noteModel'
export type { SyncStatus, ImportResult } from './sync/engine'

/** How often to retry while offline or with unsynced changes (the `online` event isn't always reliable). */
const RETRY_MS = 5_000

/**
 * React binding for the offline-first sync engine: notes come from the
 * on-device cache first, edits are queued and pushed when a connection exists.
 */
export function useNotes(dek: CryptoKey) {
  const engine = useMemo(
    () =>
      new NoteSync(dek, api, localStore, {
        onConflict: () => toast(t('store.conflict')),
        onMerged: () => toast(t('store.merged')),
        onRejected: () => toast.error(t('store.saveFailed')),
        onLoadFailed: () => toast.error(t('store.loadFailed')),
        conflictTitle: (title) => (title ? t('store.conflictCopy', { title }) : t('store.conflictUntitled')),
      }),
    [dek],
  )
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot)

  useEffect(() => {
    void engine.start()

    const onOnline = () => void engine.sync({ reconcile: true })
    const onOffline = () => engine.markOffline()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void engine.sync({ reconcile: true })
      // Phones may kill a backgrounded app without warning: queue edits now.
      else engine.flushDirty()
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!engine.hasUnqueuedEdits()) return
      engine.flushDirty()
      e.preventDefault()
    }
    const timer = setInterval(() => {
      if (navigator.onLine !== false) engine.retry() // skip while the browser knows it has no network
    }, RETRY_MS)

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('visibilitychange', onVisibility)
      engine.stop()
    }
  }, [engine])

  const list = useMemo(() => [...snap.notes.values()], [snap.notes])

  return {
    notes: list,
    byId: snap.notes,
    loading: snap.loading,
    status: snap.status,
    upsert: engine.upsert,
    update: engine.update,
    flush: engine.flushDirty,
    discard: engine.discard,
    destroy: engine.destroy,
    importMany: engine.importMany,
    sync: engine.sync,
  }
}
