import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { t } from '@/i18n'
import type { Note } from './notes'

/** Presets for reminder dates: later today (18:00 if before 17:00), tomorrow (08:00), next Monday (08:00). */
export function reminderPresets(now: Date): { laterToday: number | null; tomorrowMorning: number; nextWeek: number } {
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  const cutoff = new Date(y, m, d, 17, 0, 0, 0).getTime()
  const laterToday = now.getTime() < cutoff ? new Date(y, m, d, 18, 0, 0, 0).getTime() : null
  const tomorrowMorning = new Date(y, m, d + 1, 8, 0, 0, 0).getTime()
  const day = now.getDay()
  const daysUntilMonday = ((8 - day) % 7) || 7
  const nextWeek = new Date(y, m, d + daysUntilMonday, 8, 0, 0, 0).getTime()
  return { laterToday, tomorrowMorning, nextWeek }
}

export function isOverdue(at: number, now = Date.now()): boolean {
  return at <= now
}

/** Non-trashed notes with a reminder, sorted ascending (overdue first). */
export function withReminders(notes: Note[]): Note[] {
  return notes
    .filter((n) => !n.trashedAt && typeof n.reminder === 'number')
    .sort((a, b) => a.reminder! - b.reminder!)
}

/** Notes due for notification (reminder <= now, not trashed, not archived, not already notified). */
export function dueToNotify(notes: Note[], now: number, notified: Set<string>): Note[] {
  return notes.filter(
    (n) =>
      typeof n.reminder === 'number' &&
      n.reminder <= now &&
      !n.trashedAt &&
      !n.archived &&
      !notified.has(`${n.id}:${n.reminder}`),
  )
}

const NOTIFIED_KEY = 'noteflare:notified'
const MAX_NOTIFIED = 500

export function loadNotified(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

export function markNotified(keys: string[]): void {
  try {
    const existing = Array.from(loadNotified())
    const combined = Array.from(new Set([...existing, ...keys]))
    const trimmed = combined.slice(-MAX_NOTIFIED)
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(trimmed))
  } catch {
    /* ignore */
  }
}

/** Ask browser notification permission on user action if still default. */
export function askNotifyPermission(): void {
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission()
  }
}

/**
 * Alert the user when reminders are due: toast and desktop Notification.
 * Checks on mount, on a timer capped at 60 s, and when the window becomes visible.
 */
export function useReminderAlerts(notes: Note[], open: (id: string) => void) {
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const check = () => {
      const now = Date.now()
      const notified = loadNotified()
      const due = dueToNotify(notes, now, notified)
      if (due.length > 0) {
        const keys = due.map((n) => `${n.id}:${n.reminder}`)
        markNotified(keys)
        for (const note of due) {
          const title = note.title || t('rem.untitled')
          const description = t('rem.due')
          toast(title, {
            description,
            action: {
              label: t('rem.open'),
              onClick: () => openRef.current(note.id),
            },
          })
          if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
            const notif = new Notification(title, { body: description, tag: note.id })
            notif.onclick = () => {
              window.focus()
              openRef.current(note.id)
            }
          }
        }
      }

      let soonestDiff = 60_000
      for (const n of notes) {
        if (!n.trashedAt && !n.archived && typeof n.reminder === 'number' && n.reminder > now) {
          const diff = n.reminder - now
          if (diff < soonestDiff) soonestDiff = diff
        }
      }
      const delay = Math.max(0, Math.min(60_000, soonestDiff))
      timer = setTimeout(check, delay)
    }

    check()

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer)
        check()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [notes])
}
