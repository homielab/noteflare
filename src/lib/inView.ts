type ObserverCtor = new (
  cb: (entries: { target: Element; isIntersecting: boolean }[]) => void,
  init?: { rootMargin?: string },
) => { observe(el: Element): void; unobserve(el: Element): void }

export interface InView {
  /** Calls `onEnter` once, the first time `el` comes near the screen. Returns the cleanup. */
  watch(el: Element, onEnter: () => void): () => void
}

export function createInView(
  Observer: ObserverCtor | undefined = typeof IntersectionObserver === 'undefined' ? undefined : IntersectionObserver,
  rootMargin = '300px',
): InView {
  if (!Observer) {
    return {
      watch(_el: Element, onEnter: () => void) {
        onEnter()
        return () => {}
      },
    }
  }

  let observer: { observe(el: Element): void; unobserve(el: Element): void } | null = null
  const targets = new Map<Element, () => void>()

  return {
    watch(el: Element, onEnter: () => void) {
      if (!observer) {
        observer = new Observer(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                const cb = targets.get(entry.target)
                if (cb) {
                  targets.delete(entry.target)
                  observer?.unobserve(entry.target)
                  cb()
                }
              }
            }
          },
          { rootMargin },
        )
      }

      targets.set(el, onEnter)
      observer.observe(el)

      return () => {
        targets.delete(el)
        observer?.unobserve(el)
      }
    },
  }
}

export const inView = createInView()
