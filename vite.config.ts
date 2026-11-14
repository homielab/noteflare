import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * Emits dist/sw.js with the list of files to precache and a version derived
 * from their content, so every deploy that changes the app ships a new worker.
 */
function serviceWorker(): Plugin {
  return {
    name: 'noteflare-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      const publicDir = join(root, 'public')
      const publicFiles = walk(publicDir)
        .map((f) => '/' + relative(publicDir, f).split('\\').join('/'))
        .filter((f) => f !== '/_headers' && f !== '/robots.txt' && f !== '/icons/icon.svg' && !f.startsWith('/screenshots/')) // screenshots are only for the install dialog
      const built = Object.keys(bundle)
        .filter((f) => f !== 'index.html' && !f.endsWith('.map') && !f.endsWith('.woff')) // browsers that use .woff don't support service workers
        .map((f) => '/' + f)
      const files = ['/', ...built, ...publicFiles]

      const hash = createHash('sha256')
      for (const f of built) hash.update(f)
      const html = bundle['index.html']
      if (html && html.type === 'asset') hash.update(String(html.source))
      for (const f of publicFiles) hash.update(readFileSync(join(publicDir, f)))
      const version = hash.digest('hex').slice(0, 12)

      const source = readFileSync(join(root, 'src/sw/sw.js'), 'utf8')
        .replace("const VERSION = '__VERSION__'", `const VERSION = ${JSON.stringify(version)}`)
        .replace('const PRECACHE = __PRECACHE__', `const PRECACHE = ${JSON.stringify(files, null, 2)}`)
      if (source.includes('__VERSION__') || source.includes('__PRECACHE__')) {
        this.error('sw.js placeholders were not replaced')
      }
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Dev: `bun run dev:api` (wrangler, port 8787) + `bun run dev` (vite). The service worker is build-only.
  server: { proxy: { '/api': 'http://localhost:8787' } },
  build: { outDir: 'dist' },
})
