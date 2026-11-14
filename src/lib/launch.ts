/**
 * How NoteFlare was opened, beyond a plain visit:
 *
 * - `/?new`                         home-screen shortcut "New note"
 * - `/?share_title=…&share_text=…`  something shared to NoteFlare (manifest share_target)
 * - `.md` files                     opened with the installed app (manifest file_handlers)
 *
 * With `launch_handler: focus-existing`, an installed NoteFlare that's already open is
 * focused instead of reloaded (which would lock it again) and the launch arrives through
 * `window.launchQueue`. Elsewhere it arrives as URL parameters on a normal page load.
 * Actions wait here until the notebook is unlocked and ready to take them.
 */
export type LaunchAction =
  | { kind: 'new' }
  | { kind: 'share'; title: string; text: string }
  | { kind: 'files'; files: File[] }

interface LaunchParams {
  targetURL?: string
  files: readonly FileSystemHandle[]
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void
}

const pending: LaunchAction[] = []
let consumer: ((a: LaunchAction) => void) | null = null
// A cold start can report the same launch twice (URL and launchQueue); handle it once.
let lastSearch = ''
let lastAt = 0

function deliver(a: LaunchAction) {
  if (consumer) consumer(a)
  else pending.push(a)
}

/** Reads a URL's launch parameters, if any. Exported for tests. */
export function parseLaunchURL(href: string): LaunchAction | null {
  const p = new URL(href, 'https://x.invalid').searchParams
  if (p.has('new')) return { kind: 'new' }
  const title = (p.get('share_title') ?? '').trim()
  let text = (p.get('share_text') ?? '').trim()
  const url = (p.get('share_url') ?? '').trim()
  if (!title && !text && !url) return null
  // Many apps put the link inside the text already; don't add it twice.
  if (url && !text.includes(url)) text = text ? `${text}\n\n${url}` : url
  return { kind: 'share', title: title.slice(0, 300), text }
}

function fromURL(href: string) {
  const u = new URL(href, location.origin)
  if (!u.search || (u.search === lastSearch && Date.now() - lastAt < 5000)) return
  lastSearch = u.search
  lastAt = Date.now()
  const action = parseLaunchURL(u.href)
  if (action) deliver(action)
}

export function setupLaunch() {
  fromURL(location.href)
  // Keep the address clean so a reload doesn't repeat the launch.
  if (location.search) history.replaceState(null, '', location.pathname + location.hash)

  const queue = (window as { launchQueue?: LaunchQueue }).launchQueue
  queue?.setConsumer(async (params) => {
    const handles = params.files.filter((h): h is FileSystemFileHandle => h.kind === 'file')
    if (handles.length) {
      const files = await Promise.all(handles.map((h) => h.getFile()))
      deliver({ kind: 'files', files })
      return
    }
    if (params.targetURL) fromURL(params.targetURL)
  })
}

/** The notebook calls this once it's unlocked; queued launches are handed over right away. */
export function onLaunch(fn: (a: LaunchAction) => void) {
  consumer = fn
  for (const a of pending.splice(0)) fn(a)
  return () => {
    if (consumer === fn) consumer = null
  }
}
