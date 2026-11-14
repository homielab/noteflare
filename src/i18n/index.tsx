import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { en, type MessageKey } from './en'
import { vi } from './vi'

export type { MessageKey }
export type Lang = 'en' | 'vi'
export const LANGS: { code: Lang; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'vi', name: 'Tiếng Việt' },
]

const dicts: Record<Lang, Record<MessageKey, string>> = { en, vi }

function readLang(): Lang {
  try {
    const saved = localStorage.getItem('lang')
    if (saved === 'en' || saved === 'vi') return saved
  } catch {
    /* ignore */
  }
  return 'en' // English by default
}

let current: Lang = readLang()

/**
 * Translate a key. Usable outside React too (toasts from the note store),
 * where it reads the language last set by <I18nProvider>.
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  let s = dicts[current][key] ?? en[key]
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

export const dateLocale = () => (current === 'vi' ? 'vi-VN' : 'en-US')

interface I18nState {
  lang: Lang
  setLang: (l: Lang) => void
  t: typeof t
}

const I18nContext = createContext<I18nState>({ lang: current, setLang: () => {}, t })

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const setLang = useCallback((l: Lang) => {
    current = l
    try {
      localStorage.setItem('lang', l)
    } catch {
      /* ignore */
    }
    setLangState(l)
  }, [])

  // A new `t` per language so memoized components re-render too.
  const tr = useCallback<typeof t>((key, vars) => t(key, vars), [lang]) // eslint-disable-line react-hooks/exhaustive-deps

  return <I18nContext.Provider value={{ lang, setLang, t: tr }}>{children}</I18nContext.Provider>
}

export const useI18n = () => useContext(I18nContext)
