import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { setupPwa } from './lib/pwa'
import { setupViewport } from './lib/viewport'
import { setupLaunch } from './lib/launch'

// Apply the theme before first render to avoid a flash.
try {
  const t = localStorage.getItem('theme')
  if (t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches))
    document.documentElement.classList.add('dark')
} catch {
  /* ignore */
}

setupPwa()
setupViewport()
setupLaunch()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
