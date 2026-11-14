/*
 * NoteFlare service worker.
 *
 * - The app shell (HTML, JS, CSS, fonts, icons) is precached so NoteFlare opens offline.
 * - Page loads go to the network first: when the Cloudflare Access session has
 *   expired, the login redirect must reach the browser. The cached shell is used
 *   only when the network fails or is too slow.
 * - /api is never touched here. Notes are cached by the app itself, encrypted, in IndexedDB.
 * - A new version installs in the background and waits. The app asks the user to reload,
 *   then sends SKIP_WAITING, so a page never runs against assets from another version.
 *
 * The version and precache list are filled in at build time (see vite.config.ts).
 */
const VERSION = '__VERSION__'
const PRECACHE = __PRECACHE__
const CACHE = `noteflare-${VERSION}`
const SHELL = '/'
const NAV_TIMEOUT_MS = 3500

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await Promise.all(
        PRECACHE.map(async (url) => {
          // `manual`: if Access answers with a login redirect, fail instead of caching the login page.
          const res = await fetch(url, { cache: 'reload', credentials: 'same-origin', redirect: 'manual' })
          if (!res.ok) throw new Error(`Precache failed for ${url}: ${res.status || res.type}`)
          await cache.put(url, res)
        }),
      )
      // The very first install takes over at once; updates wait for the user (see 'message').
      if (!self.registration.active) await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k.startsWith('noteflare-') && k !== CACHE).map((k) => caches.delete(k)))
      // Start the page request while the worker boots, so navigations aren't slowed down.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {})
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi/')) return

  if (req.mode === 'navigate') {
    event.respondWith(navigate(req, event.preloadResponse))
    return
  }
  event.respondWith(staticAsset(req, url))
})

async function navigate(req, preload) {
  const cache = await caches.open(CACHE)
  const network = Promise.resolve(preload)
    .then((res) => res || fetch(req))
    .then(async (res) => {
      // Only a real page refreshes the shell; redirects (Access login) pass straight through.
      if (res.ok && res.type === 'basic') void cache.put(SHELL, res.clone())
      // Server errors: the saved app still works with the copy of your notes on this device.
      if (res.status >= 500) return (await cache.match(SHELL)) ?? res
      return res
    })
  const timeout = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS, null))
  try {
    const res = await Promise.race([network, timeout])
    if (res) return res
    // Slow network: show the cached app now; the network response still refreshes the cache.
    return (await cache.match(SHELL)) ?? (await network)
  } catch {
    return (await cache.match(SHELL)) ?? Response.error()
  }
}

async function staticAsset(req, url) {
  const hit = await caches.match(req, { ignoreSearch: true })
  if (hit) return hit
  const res = await fetch(req)
  // Hashed build files never change, so they're safe to cache on first use.
  if (res.ok && res.type === 'basic' && url.pathname.startsWith('/assets/')) {
    const cache = await caches.open(CACHE)
    void cache.put(req, res.clone())
  }
  return res
}
