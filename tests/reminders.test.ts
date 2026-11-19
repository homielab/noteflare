import { beforeEach, describe, expect, it } from 'vitest'
import { emptyNote, type Note } from '../src/lib/noteModel'
import {
  dueToNotify,
  isOverdue,
  loadNotified,
  markNotified,
  reminderPresets,
  withReminders,
} from '../src/lib/reminders'

const note = (patch: Partial<Note>): Note => ({ ...emptyNote(), ...patch })

describe('reminders', () => {
  describe('reminderPresets', () => {
    it('handles Sunday before 17:00', () => {
      // 2026-11-15 is Sunday
      const now = new Date(2026, 10, 15, 14, 30)
      const presets = reminderPresets(now)
      expect(presets.laterToday).toBe(new Date(2026, 10, 15, 18, 0).getTime())
      expect(presets.tomorrowMorning).toBe(new Date(2026, 10, 16, 8, 0).getTime())
      expect(presets.nextWeek).toBe(new Date(2026, 10, 16, 8, 0).getTime())
    })

    it('handles Sunday after 17:00 (laterToday is null)', () => {
      // 2026-11-15 17:00 or later
      const now = new Date(2026, 10, 15, 18, 30)
      const presets = reminderPresets(now)
      expect(presets.laterToday).toBeNull()
      expect(presets.tomorrowMorning).toBe(new Date(2026, 10, 16, 8, 0).getTime())
      expect(presets.nextWeek).toBe(new Date(2026, 10, 16, 8, 0).getTime())
    })

    it('handles Monday (nextWeek is the Monday after)', () => {
      // 2026-11-16 is Monday
      const now = new Date(2026, 10, 16, 10, 0)
      const presets = reminderPresets(now)
      expect(presets.laterToday).toBe(new Date(2026, 10, 16, 18, 0).getTime())
      expect(presets.tomorrowMorning).toBe(new Date(2026, 10, 17, 8, 0).getTime())
      expect(presets.nextWeek).toBe(new Date(2026, 10, 23, 8, 0).getTime())
    })
  })

  describe('withReminders', () => {
    it('returns non-trashed notes sorted ascending by reminder', () => {
      const a = note({ id: 'a', reminder: 300 })
      const b = note({ id: 'b', reminder: 100 })
      const c = note({ id: 'c', reminder: 200 })
      const noRem = note({ id: 'd' })
      const trashed = note({ id: 'e', reminder: 50, trashedAt: Date.now() })

      const result = withReminders([a, b, c, noRem, trashed])
      expect(result.map((n) => n.id)).toEqual(['b', 'c', 'a'])
    })
  })

  describe('dueToNotify', () => {
    it('skips archived, trashed, future, and already-notified notes', () => {
      const now = 1000
      const due = note({ id: 'due', reminder: 900 })
      const exact = note({ id: 'exact', reminder: 1000 })
      const future = note({ id: 'future', reminder: 1001 })
      const archived = note({ id: 'arch', reminder: 800, archived: true })
      const trashed = note({ id: 'trash', reminder: 800, trashedAt: 500 })
      const notified = note({ id: 'notified', reminder: 800 })

      const notifiedSet = new Set([`notified:800`])
      const res = dueToNotify([due, exact, future, archived, trashed, notified], now, notifiedSet)

      expect(res.map((n) => n.id)).toEqual(['due', 'exact'])
    })
  })

  describe('isOverdue', () => {
    it('checks whether timestamp is at or before now', () => {
      const now = 5000
      expect(isOverdue(4999, now)).toBe(true)
      expect(isOverdue(5000, now)).toBe(true)
      expect(isOverdue(5001, now)).toBe(false)
    })
  })

  describe('storage', () => {
    const mem = new Map<string, string>()
    beforeEach(() => {
      mem.clear()
      globalThis.localStorage = {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, String(v)),
        removeItem: (k: string) => void mem.delete(k),
        clear: () => mem.clear(),
        key: () => null,
        length: 0,
      } as Storage
    })

    it('loads empty set by default and stores newest 500 keys', () => {
      expect(loadNotified().size).toBe(0)

      const keys: string[] = []
      for (let i = 0; i < 600; i++) keys.push(`key-${i}`)
      markNotified(keys)

      const loaded = loadNotified()
      expect(loaded.size).toBe(500)
      expect(loaded.has('key-0')).toBe(false)
      expect(loaded.has('key-599')).toBe(true)
    })
  })
})
