import { memo, type ComponentProps } from 'react'
import { Markdown, type MarkdownComponents } from '@tanstack/markdown/react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { highlightCode } from '@/lib/highlight'

interface Props {
  source: string
  /** When set, checkboxes are clickable and report their index. */
  onToggleTask?: (index: number) => void
  className?: string
  /**
   * False for text that comes from outside the user's own notes (release notes from GitHub):
   * images are shown as their alt text, so rendering never contacts a third-party server.
   */
  images?: boolean
}

/**
 * Renders Markdown with TanStack Markdown. The library escapes raw HTML and drops
 * executable URLs (javascript:…) by default, so no extra sanitizing step is needed.
 */
export const NoteMarkdown = memo(function NoteMarkdown({ source, onToggleTask, className, images = true }: Props) {
  const { t } = useI18n()
  let taskIndex = 0 // render order matches source order

  const components: MarkdownComponents = {
    a: (props: ComponentProps<'a'>) => (
      <a {...props} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => e.stopPropagation()} />
    ),
    input: (props: ComponentProps<'input'>) => {
      if (props.type !== 'checkbox') return <input {...props} />
      const index = taskIndex++
      return (
        <input
          type="checkbox"
          checked={!!props.checked}
          disabled={!onToggleTask}
          aria-label={props.checked ? t('card.markUndone') : t('card.markDone')}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggleTask?.(index)}
        />
      )
    },
    img: (props: ComponentProps<'img'>) =>
      images ? (
        <img {...props} loading="lazy" referrerPolicy="no-referrer" />
      ) : props.alt ? (
        <span className="text-muted-foreground">[{props.alt}]</span>
      ) : null,
  }

  return (
    <div className={cn('md', className)}>
      <Markdown components={components} highlighter={highlightCode}>
        {source}
      </Markdown>
    </div>
  )
})
