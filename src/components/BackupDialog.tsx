import { useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { FileArchive, FileLock2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { encryptNote, unlockWithPassphrase, UnsafeKdfError, WrongSecretError } from '@/lib/crypto'
import {
  buildBackup,
  canDecryptBackup,
  decryptBackup,
  downloadFile,
  exportStamp,
  InvalidBackupError,
  markdownEntries,
  parseBackup,
  type BackupFile,
} from '@/lib/exportNotes'
import type { ParsedNote } from '@/lib/importMarkdown'
import { localRow, toPayload } from '@/lib/noteModel'
import type { ImportResult, Note } from '@/lib/notes'
import { localStore } from '@/lib/sync/localStore'
import { makeZip, type ZipEntry } from '@/lib/zip'
import { attachmentExtension, attachmentIds, loadAttachment } from '@/lib/attachments'
import { useI18n } from '@/i18n'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  dek: CryptoKey
  notes: Note[]
  onImport: (notes: ParsedNote[]) => Promise<ImportResult>
}

/** Export as Markdown, download an encrypted backup, or restore one. */
export function BackupDialog({ open, onOpenChange, dek, notes, onImport }: Props) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  // A backup made with another key (another deployment, or before a reset) waits here for its passphrase.
  const [locked, setLocked] = useState<BackupFile | null>(null)
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const live = notes.filter((n) => !n.trashedAt)

  const reset = () => {
    setLocked(null)
    setPass('')
    setError(null)
  }

  const guard = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      if (err instanceof InvalidBackupError) setError(t('bk.invalid'))
      else if (err instanceof WrongSecretError || err instanceof UnsafeKdfError) setError(t('bk.wrongPass'))
      else setError(t('bk.failed'))
    } finally {
      setBusy(false)
    }
  }

  const exportMarkdown = () =>
    guard(async () => {
      if (!live.length) return void toast(t('bk.empty'))
      // Attached images are decrypted into the archive next to the notes that use them.
      const images: ZipEntry[] = []
      const names = new Map<string, string>()
      let missing = 0
      for (const id of new Set(live.flatMap((n) => attachmentIds(n.body)))) {
        try {
          const image = await loadAttachment(dek, id)
          names.set(id, `${id}.${attachmentExtension(image.type)}`)
          images.push({ name: `NoteFlare/attachments/${names.get(id)}`, data: image.bytes })
        } catch {
          missing++
        }
      }
      downloadFile(`noteflare-${exportStamp()}.zip`, makeZip([...markdownEntries(live, 'NoteFlare', names), ...images]), 'application/zip')
      toast.success(t('bk.exported', { n: live.length }), { description: missing ? t('bk.imagesMissing', { n: missing }) : undefined })
    })

  const exportBackup = () =>
    guard(async () => {
      const vault = await localStore.getVault()
      if (!vault || !live.length) return void toast(t('bk.empty'))
      // Encrypt what is on screen now, so edits that have not synced yet are included.
      const rows = await Promise.all(
        live.map(async (n) => {
          const { ciphertext, iv } = await encryptNote(dek, n.id, toPayload(n))
          return localRow(n, ciphertext, iv)
        }),
      )
      downloadFile(`noteflare-backup-${exportStamp()}.json`, JSON.stringify(buildBackup(vault, rows)), 'application/json')
      toast.success(t('bk.backedUp', { n: rows.length }))
    })

  const restore = async (backup: BackupFile, key: CryptoKey) => {
    const { notes: found, failed } = await decryptBackup(backup, key)
    const res = await onImport(found)
    const added = res.created + res.queued
    const skipped = failed + res.failed
    const description = skipped ? t('imp.failed', { n: skipped }) : undefined
    if (added) toast.success(t('bk.restored', { n: added }), { description })
    else toast(t('bk.restoredNone'), { description })
    reset()
    onOpenChange(false)
  }

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    void guard(async () => {
      const backup = parseBackup(await file.text())
      if (await canDecryptBackup(backup, dek)) await restore(backup, dek)
      else setLocked(backup)
    })
  }

  const unlockBackup = (e: FormEvent) => {
    e.preventDefault()
    if (!locked) return
    void guard(async () => restore(locked, await unlockWithPassphrase(locked.vault, pass)))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('bk.title')}</DialogTitle>
          <DialogDescription>{t('bk.body')}</DialogDescription>
        </DialogHeader>

        {locked ? (
          <form onSubmit={unlockBackup} className="grid gap-3">
            <p className="text-sm text-muted-foreground">{t('bk.needPass')}</p>
            <Input
              type="password"
              autoFocus
              autoComplete="off"
              aria-label={t('bk.passphrase')}
              placeholder={t('bk.passphrase')}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
            {error && <ErrorLine>{error}</ErrorLine>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={reset} disabled={busy}>
                {t('common.close')}
              </Button>
              <Button type="submit" disabled={busy || !pass}>
                {busy ? t('bk.restoring') : t('bk.restore')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-5">
            <Row title={t('bk.mdTitle')} body={t('bk.mdBody')}>
              <Button variant="outline" onClick={() => void exportMarkdown()} disabled={busy}>
                <FileArchive /> {t('bk.mdButton')}
              </Button>
            </Row>
            <Row title={t('bk.encTitle')} body={t('bk.encBody')}>
              <Button variant="outline" onClick={() => void exportBackup()} disabled={busy}>
                <FileLock2 /> {t('bk.encButton')}
              </Button>
            </Row>
            <Row title={t('bk.restoreTitle')} body={t('bk.restoreBody')}>
              <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={busy}>
                <Upload /> {busy ? t('bk.restoring') : t('bk.restoreButton')}
              </Button>
            </Row>
            {error && <ErrorLine>{error}</ErrorLine>}
            <input ref={fileInput} type="file" hidden accept=".json,application/json" onChange={onPick} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Row({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      <div>{children}</div>
    </section>
  )
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  )
}
