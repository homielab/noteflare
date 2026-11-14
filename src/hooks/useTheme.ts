import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'

function read(): Theme {
  try {
    return (localStorage.getItem('theme') as Theme) || 'system'
  } catch {
    return 'system'
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(read)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
      // Match the phone's status bar / browser chrome to the app background.
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#18181a' : '#f7f6f4')
    }
    apply()
    try {
      localStorage.setItem('theme', theme)
    } catch {
      /* ignore */
    }
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  return { theme, setTheme }
}
