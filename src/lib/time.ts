import { dateLocale } from '@/i18n'

/** "3 minutes ago", "in 2 days" — in the current UI language. */
export function relativeTime(ms: number) {
  const diff = (ms - Date.now()) / 1000
  const rtf = new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'auto' })
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  for (const [unit, sec] of steps) if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit)
  return rtf.format(0, 'minute')
}

/** A timestamp, or a calendar date like "2026-11-17" (shown as that day everywhere). */
export function shortDate(input: number | string) {
  const dateOnly = typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)
  return new Date(input).toLocaleDateString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(dateOnly ? { timeZone: 'UTC' } : null),
  })
}
