import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { en, type MessageKey } from './en'
import { vi } from './vi'
import { es } from './es'
import { fr } from './fr'
import { de } from './de'
import { pt } from './pt'
import { zh } from './zh'

export type { MessageKey }
export type Lang = 'en' | 'vi' | 'es' | 'fr' | 'de' | 'pt' | 'zh'
export const LANGS: { code: Lang; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt', name: 'Português (Brasil)' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'zh', name: '简体中文' },
]

const dicts: Record<Lang, Record<MessageKey, string>> = { en, vi, es, fr, de, pt, zh }

/**
 * Pick the first browser language we speak, by prefix ('es-419' → 'es',
 * 'pt-PT' → 'pt'). First match wins, English otherwise.
 */
export function detectLang(prefs: readonly string[]): Lang {
  for (const pref of prefs) {
    const p = pref.toLowerCase()
    if (p.startsWith('es')) return 'es'
    if (p.startsWith('fr')) return 'fr'
    if (p.startsWith('de')) return 'de'
    if (p.startsWith('pt')) return 'pt'
    if (p.startsWith('vi')) return 'vi'
    if (p.startsWith('zh')) return 'zh'
    if (p.startsWith('en')) return 'en'
  }
  return 'en'
}

function readLang(): Lang {
  try {
    const saved = localStorage.getItem('lang')
    if (saved && LANGS.some((l) => l.code === saved)) return saved as Lang
  } catch {
    /* ignore */
  }
  try {
    return detectLang(navigator.languages ?? [navigator.language])
  } catch {
    /* ignore */
  }
  return 'en'
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

const DATE_LOCALES: Record<Lang, string> = {
  en: 'en-US',
  vi: 'vi-VN',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  pt: 'pt-BR',
  zh: 'zh-CN',
}

export const dateLocale = () => DATE_LOCALES[current]

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
