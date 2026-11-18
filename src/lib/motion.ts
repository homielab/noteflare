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
 * Which note cards take part in a transition: those on or near the screen,
 * one note's card, or none. Every named element costs the browser a snapshot,
 * so a board of hundreds of notes must never name them all.
 */
export type TransitionCards = 'near' | 'none' | { id: string }

const CARD_MARK = 'data-vt'

function pickCards(cards: TransitionCards): HTMLElement[] {
  if (cards === 'none') return []
  const all = document.querySelectorAll<HTMLElement>('[data-note]')
  if (cards !== 'near') return Array.from(all).filter((el) => el.dataset.note === cards.id)
  const margin = innerHeight / 2
  return Array.from(all).filter((el) => {
    const r = el.getBoundingClientRect()
    return r.bottom > -margin && r.top < innerHeight + margin
  })
}

/**
 * Run a state update inside a View Transition so elements with a
 * `view-transition-name` slide/morph to their new place. Cards get their name
 * (index.css) only while marked here: before the update for where they are,
 * after it for the ones that arrive.
 * Unsupported browser or reduced motion: just update.
 */
export function transition(update: () => void, cards: TransitionCards = 'near') {
  if (!supportsViewTransitions()) return update()
  const before = pickCards(cards)
  for (const el of document.querySelectorAll(`[${CARD_MARK}]`)) el.removeAttribute(CARD_MARK)
  for (const el of before) el.setAttribute(CARD_MARK, '')
  const t = document.startViewTransition(() => {
    flushSync(update)
    for (const el of pickCards(cards)) el.setAttribute(CARD_MARK, '')
  })
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
