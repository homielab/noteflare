import { flushSync } from 'react-dom'

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * View Transitions are used only where `view-transition-class` is supported too:
 * classes are what lets us layer groups (editor above backdrop above cards).
 */
export const supportsViewTransitions = () =>
  typeof document !== 'undefined' &&
  'startViewTransition' in document &&
  typeof CSS !== 'undefined' &&
  CSS.supports('view-transition-class', 'card') &&
  !prefersReducedMotion()

/**
 * Run a state update inside a View Transition so elements with a
 * `view-transition-name` slide/morph to their new place.
 * Unsupported browser or reduced motion: just update.
 */
export function transition(update: () => void) {
  if (!supportsViewTransitions()) return update()
  const t = document.startViewTransition(() => flushSync(update))
  // A new transition may interrupt a running one — expected, not an error.
  const ignore = () => {}
  t.ready.catch(ignore)
  t.finished.catch(ignore)
  t.updateCallbackDone.catch(ignore)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** A string that looks like ciphertext — decoration only. */
export function cipherNoise(length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => B64[b & 63]).join('')
}

export const vtName = (id: string) => `note-${id}`

/**
 * Layering inside a view transition. Every named element becomes its own group,
 * and groups paint in DOM order — not by the page's z-index — so without these
 * classes later cards would paint over the editor while it grows.
 * Matching z-index rules live in index.css.
 */
export const VT_CLASS = { card: 'card', fab: 'fab', editor: 'editor' } as const

/**
 * Theme switch: the new theme spreads out in a circle from the button that was pressed.
 * Named elements are flattened into one snapshot for the duration, so the whole page
 * reveals together instead of cards cross-fading on their own.
 */
export function themeTransition(origin: HTMLElement | null, update: () => void) {
  const root = document.documentElement
  if (!('startViewTransition' in document) || prefersReducedMotion() || !origin) return update()
  const r = origin.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))

  root.classList.add('theme-vt')
  const t = document.startViewTransition(() => flushSync(update))
  const done = () => root.classList.remove('theme-vt')
  t.finished.then(done, done)
  t.updateCallbackDone.catch(() => {})
  t.ready
    .then(() =>
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
      ),
    )
    .catch(() => {})
}
