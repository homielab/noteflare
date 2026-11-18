import { CloudAlert, HardDrive, ImageOff, LockKeyhole, Paperclip, WifiOff, X, type LucideIcon } from 'lucide-react'
import { useI18n, type MessageKey } from '@/i18n'
import { cn } from '@/lib/utils'

export type ImageFailure = 'offline' | 'network' | 'deleted' | 'disabled' | 'undecryptable'

interface Props {
  state: 'loading' | 'uploading' | ImageFailure
  /** The image's name; shown in every failure state and under an upload. */
  alt?: string
  /** Reserve this ratio; 4:3 without them. */
  width?: number
  height?: number
  /** Uploading: object URL of the local file. */
  preview?: string
  /** Uploading: 0..1. */
  progress?: number
  onRetry?: () => void
  onCancel?: () => void
  /** Cover the parent box (a grid tile) instead of reserving a ratio. */
  fill?: boolean
}

const FAILURES: Record<ImageFailure, { icon: LucideIcon; message: MessageKey }> = {
  offline: { icon: WifiOff, message: 'att.offline' },
  network: { icon: CloudAlert, message: 'att.loadFailed' },
  deleted: { icon: ImageOff, message: 'att.deleted' },
  disabled: { icon: HardDrive, message: 'att.storageOff' },
  undecryptable: { icon: LockKeyhole, message: 'att.undecryptable' },
}

/**
 * The box shown instead of an image that is not (yet) on screen: loading, uploading or why it
 * failed. Only inline elements, so it can sit inside a Markdown paragraph.
 */
export function ImagePlaceholder({ state, alt, width, height, preview, progress = 0, onRetry, onCancel, fill }: Props) {
  const { t } = useI18n()
  const uploading = state === 'uploading'
  const box = cn(
    'relative block overflow-hidden rounded-md bg-foreground/[0.07]',
    uploading && 'size-28',
    fill && !uploading && 'absolute inset-0 rounded-none',
  )
  const style =
    uploading || fill
      ? undefined
      : { aspectRatio: `${width ?? 4} / ${height ?? 3}`, width: `min(100%, ${width ? `${width}px` : '20rem'})` }

  if (state === 'loading')
    return (
      <span className={cn(box, 'skeleton skeleton-flat')} style={style} role="status">
        <span className="sr-only">{t('att.loading')}</span>
      </span>
    )

  if (uploading) {
    const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100)
    return (
      <span className={box} style={style}>
        {preview ? (
          <img src={preview} alt="" draggable={false} className="absolute inset-0 size-full scale-110 object-cover blur-sm" />
        ) : (
          <Paperclip className="absolute top-1/2 left-1/2 size-6 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
        )}
        {alt && (
          <span className="absolute inset-x-1.5 bottom-2.5 block truncate rounded bg-background/70 px-1 text-center text-xs">{alt}</span>
        )}
        <span
          className="absolute inset-x-0 bottom-0 block h-1 bg-foreground/15"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t('att.uploading')}
        >
          <span className="block h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </span>
        {onCancel && (
          <button
            type="button"
            className="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-background/80 hover:bg-background"
            aria-label={t('att.cancelUpload')}
            onClick={(e) => {
              e.stopPropagation()
              onCancel()
            }}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </span>
    )
  }

  const { icon: Icon, message } = FAILURES[state]
  return (
    <span className={box} style={style}>
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center text-xs">
        <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <span>{t(message)}</span>
        {alt && <span className="max-w-full truncate text-muted-foreground">{alt}</span>}
        {state === 'network' && onRetry && (
          <button
            type="button"
            className="rounded-md bg-foreground/10 px-2 py-0.5 hover:bg-foreground/15"
            onClick={(e) => {
              e.stopPropagation()
              onRetry()
            }}
          >
            {t('att.retry')}
          </button>
        )}
        {state === 'disabled' && (
          <a
            href="https://noteflare.homielab.com/guides/images/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
            onClick={(e) => e.stopPropagation()}
          >
            {t('att.storageOffHelp')}
          </a>
        )}
      </span>
    </span>
  )
}
