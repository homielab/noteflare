import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface Option<T extends string> {
  value: T
  label: ReactNode
  /** Accessible name when the label is only an icon. */
  ariaLabel?: string
}

/**
 * A small switch between two or three options. The highlight slides between
 * them instead of jumping, which makes mode changes easy to follow.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T
  options: readonly Option<T>[]
  onChange: (v: T) => void
  label: string
  className?: string
}) {
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('relative grid auto-cols-fr grid-flow-col rounded-md bg-foreground/[0.06] p-0.5 text-sm', className)}
    >
      <span
        aria-hidden
        className="absolute top-0.5 bottom-0.5 left-0.5 rounded bg-surface shadow-sm transition-transform duration-300 ease-[var(--ease-spring)]"
        style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.ariaLabel}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative flex items-center justify-center gap-1.5 rounded px-2.5 py-1 [@media(pointer:coarse)]:py-2 outline-none transition-colors duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4',
            o.value === value ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
