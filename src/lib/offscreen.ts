/**
 * Cards far from the screen skip their rendering work (`content-visibility: auto`,
 * index.css), which keeps a board of hundreds of notes fast. A skipped card is laid
 * out at the size the browser last saw, so a card is only skipped once it has been
 * laid out for real (`data-sized`) and is measured again when its width or content
 * changes — otherwise the masonry columns would jump while scrolling.
 */
const SIZED = 'data-sized'

const pending = new Set<Element>()
let scheduled = false

/** Lay the card out in full for a frame, then let it be skipped again. */
export function remeasure(el: Element) {
  el.removeAttribute(SIZED)
  pending.add(el)
  if (scheduled) return
  scheduled = true
  // Two frames: the first may start before the layout that has to see the full card.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      scheduled = false
      for (const card of pending) card.setAttribute(SIZED, '')
      pending.clear()
    }),
  )
}

const widths = new WeakMap<Element, number>()
let observer: ResizeObserver | undefined

/** Start skipping the card while it is off-screen. Returns the cleanup. */
export function skipWhenOffscreen(el: Element) {
  if (typeof ResizeObserver === 'undefined') return () => {}
  observer ??= new ResizeObserver((entries) => {
    for (const e of entries) {
      // A skipped card keeps reporting its width, the one thing that changes its height from outside.
      const width = Math.round(e.contentRect.width)
      if (widths.get(e.target) === width) continue
      widths.set(e.target, width)
      remeasure(e.target)
    }
  })
  observer.observe(el)
  return () => {
    observer?.unobserve(el)
    pending.delete(el)
  }
}
