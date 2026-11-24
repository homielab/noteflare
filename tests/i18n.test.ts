import { describe, expect, it } from 'vitest'
import { detectLang } from '../src/i18n/index'
import { en, type MessageKey } from '../src/i18n/en'
import { vi } from '../src/i18n/vi'
import { es } from '../src/i18n/es'
import { fr } from '../src/i18n/fr'
import { de } from '../src/i18n/de'
import { pt } from '../src/i18n/pt'
import { zh } from '../src/i18n/zh'

const LOCALES: [string, Record<MessageKey, string>][] = [
  ['vi', vi],
  ['es', es],
  ['fr', fr],
  ['de', de],
  ['pt', pt],
  ['zh', zh],
]

describe('i18n locales', () => {
  for (const [name, dict] of LOCALES) {
    it(`${name} has every key of en with the same placeholders`, () => {
      expect(Object.keys(dict).sort()).toEqual(Object.keys(en).sort())
      for (const key of Object.keys(en) as MessageKey[]) {
        const value = dict[key]
        expect(value, `${name}.${key} is empty`).not.toBe('')
        const placeholders = (s: string) => [...s.matchAll(/\{[^}]+\}/g)].map((m) => m[0]).sort()
        expect(placeholders(value), `${name}.${key} placeholders differ`).toEqual(placeholders(en[key]))
      }
    })
  }
})

describe('detectLang', () => {
  it('maps browser language preferences to a locale', () => {
    expect(detectLang(['fr-CA'])).toBe('fr')
    expect(detectLang(['pt-PT'])).toBe('pt')
    expect(detectLang(['de-DE', 'en'])).toBe('de')
    expect(detectLang(['zh-CN'])).toBe('zh')
    expect(detectLang(['zh-Hans', 'en'])).toBe('zh')
    expect(detectLang(['ja-JP'])).toBe('en')
    expect(detectLang(['ja', 'es-MX'])).toBe('es')
    expect(detectLang([])).toBe('en')
  })
})
