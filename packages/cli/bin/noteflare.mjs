#!/usr/bin/env node
/**
 * noteflare — a small command-line client for NoteFlare, built on @noteflare/client.
 *
 *   NOTEFLARE_URL=https://notes.example.com NOTEFLARE_TOKEN=nf_… noteflare ls
 *
 * Notes are decrypted on this machine with your passphrase (NOTEFLARE_PASSPHRASE,
 * or you're asked for it). Run `noteflare help` for commands.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { NoteFlareClient, NoteFlareError, WrongSecretError } from '../../client/dist/index.js'

const HELP = `noteflare — end-to-end encrypted notes from the terminal

Usage
  noteflare ls [--all] [--label <name>] [--json]   List notes (pinned first)
  noteflare show <note>                            Print a note as Markdown
  noteflare add <title> [text…] [--label a,b] [--pin]
                                                   Create a note; text from args or stdin
  noteflare append <note> <text…>                  Add lines to the end of a note
  noteflare trash <note>                           Move a note to the trash
  noteflare export <dir>                           Write every note to <dir> as Markdown
  noteflare whoami                                 Show the account and token access

<note> is an id, an id prefix, or the start of a title.

Environment
  NOTEFLARE_URL          Your NoteFlare address, e.g. https://notes.example.com
  NOTEFLARE_TOKEN        API token from Account → Integrations
  NOTEFLARE_PASSPHRASE   Optional; you're prompted when it isn't set
  NOTEFLARE_ACCESS_CLIENT_ID / NOTEFLARE_ACCESS_CLIENT_SECRET
                         Optional Cloudflare Access service token, if /api/v1 uses Service Auth`

const { flags, positionals } = parseCli(process.argv.slice(2))
const [command, ...args] = positionals

/**
 * Only the flags below are options; everything else is text. A generic parser
 * would choke on note content such as "- [ ] buy milk".
 */
function parseCli(argv) {
  const booleans = new Set(['--all', '--json', '--pin', '--help', '-h'])
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (booleans.has(a)) flags[a === '-h' ? 'help' : a.slice(2)] = true
    else if (a === '--label') flags.label = argv[++i]
    else if (a.startsWith('--label=')) flags.label = a.slice('--label='.length)
    else positionals.push(a)
  }
  return { flags, positionals }
}

async function main() {
  if (!command || command === 'help' || flags.help) return console.log(HELP)

  const url = process.env.NOTEFLARE_URL
  const token = process.env.NOTEFLARE_TOKEN
  if (!url || !token) fail('Set NOTEFLARE_URL and NOTEFLARE_TOKEN (create a token in NoteFlare → Account → Integrations).')

  const headers = {}
  if (process.env.NOTEFLARE_ACCESS_CLIENT_ID) {
    headers['CF-Access-Client-Id'] = process.env.NOTEFLARE_ACCESS_CLIENT_ID
    headers['CF-Access-Client-Secret'] = process.env.NOTEFLARE_ACCESS_CLIENT_SECRET ?? ''
  }
  const nf = new NoteFlareClient({ url, token, headers })

  if (command === 'whoami') {
    const me = await nf.me()
    return console.log(`${me.email} · ${me.scope === 'write' ? 'read & write' : 'read only'} token`)
  }

  await nf.unlock(process.env.NOTEFLARE_PASSPHRASE ?? (await askHidden('Passphrase: ')))

  switch (command) {
    case 'ls': {
      const notes = await nf.list({ archived: flags.all, label: flags.label })
      if (flags.json) return console.log(JSON.stringify(notes, null, 2))
      for (const n of notes) {
        const mark = n.pinned ? '★' : n.archived ? '▢' : ' '
        const tags = n.labels.length ? `  #${n.labels.join(' #')}` : ''
        console.log(`${n.id.slice(0, 8)} ${mark} ${n.title || firstLine(n.body) || '(empty)'}${tags}`)
      }
      return
    }
    case 'show': {
      const n = await find(nf, args.join(' '))
      return console.log(toMarkdown(n, { frontmatter: false }))
    }
    case 'add': {
      const [title, ...words] = args
      if (!title) fail('Usage: noteflare add <title> [text…]')
      const body = words.length ? words.join(' ') : await readStdin()
      const n = await nf.create({ title, body, labels: splitList(flags.label), pinned: !!flags.pin })
      return console.log(`Created ${n.id.slice(0, 8)} "${n.title}"`)
    }
    case 'append': {
      const [ref, ...words] = args
      const text = words.length ? words.join(' ') : await readStdin()
      if (!ref || !text) fail('Usage: noteflare append <note> <text…>')
      const n = await nf.append((await find(nf, ref)).id, text)
      return console.log(`Updated "${n.title || n.id.slice(0, 8)}"`)
    }
    case 'trash': {
      const n = await nf.trash((await find(nf, args.join(' '))).id)
      return console.log(`Moved "${n.title || n.id.slice(0, 8)}" to the trash`)
    }
    case 'export': {
      const dir = args[0]
      if (!dir) fail('Usage: noteflare export <dir>')
      const notes = await nf.list({ archived: true })
      const used = new Set()
      for (const n of notes) {
        const folder = join(dir, ...(n.labels.find((l) => l.includes('/'))?.split('/') ?? []))
        await mkdir(folder, { recursive: true })
        let name = safeName(n.title || firstLine(n.body) || n.id.slice(0, 8))
        for (let i = 2; used.has(join(folder, name)); i++) name = `${safeName(n.title || n.id.slice(0, 8))} (${i})`
        used.add(join(folder, name))
        await writeFile(join(folder, `${name}.md`), toMarkdown(n, { frontmatter: true }))
      }
      return console.log(`Exported ${notes.length} notes to ${dir}`)
    }
    default:
      fail(`Unknown command "${command}". Run: noteflare help`)
  }
}

/** Resolve a note by id, id prefix or title prefix (case-insensitive). */
async function find(nf, ref) {
  if (!ref) fail('Which note? Give an id or the start of its title.')
  const notes = await nf.list({ archived: true })
  const q = ref.toLowerCase()
  const hits = notes.filter((n) => n.id.startsWith(q) || n.title.toLowerCase().startsWith(q))
  if (hits.length === 1) return hits[0]
  if (!hits.length) fail(`No note matches "${ref}".`)
  fail(`"${ref}" matches ${hits.length} notes:\n` + hits.map((n) => `  ${n.id.slice(0, 8)} ${n.title}`).join('\n'))
}

/** Markdown with YAML frontmatter that NoteFlare's own importer reads back. */
function toMarkdown(n, { frontmatter }) {
  const lines = []
  if (frontmatter) {
    lines.push('---', `title: ${JSON.stringify(n.title)}`)
    if (n.labels.length) lines.push(`tags: [${n.labels.map((l) => JSON.stringify(l)).join(', ')}]`)
    if (n.color !== 'default') lines.push(`color: ${n.color}`)
    if (n.pinned) lines.push('pinned: true')
    if (n.archived) lines.push('archived: true')
    lines.push(`created: ${new Date(n.createdAt).toISOString()}`, `updated: ${new Date(n.updatedAt).toISOString()}`, '---', '')
  } else if (n.title) {
    lines.push(`# ${n.title}`, '')
  }
  lines.push(n.body, '')
  return lines.join('\n')
}

const firstLine = (s) => s.split('\n').find((l) => l.trim())?.replace(/^[#>\-*\s[\]x]+/, '').slice(0, 60) ?? ''
const splitList = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [])
const safeName = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100) || 'note'

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let s = ''
  for await (const chunk of process.stdin) s += chunk
  return s.replace(/\s+$/, '')
}

function askHidden(prompt) {
  if (!process.stdin.isTTY) fail('Set NOTEFLARE_PASSPHRASE when not running in a terminal.')
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => {
      if (s.startsWith(prompt)) process.stdout.write(prompt)
    }
    rl.question(prompt, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

main().catch((err) => {
  if (err instanceof WrongSecretError) fail("That passphrase isn't right.")
  if (err instanceof NoteFlareError) fail(err.message)
  fail(err?.stack ?? String(err))
})
