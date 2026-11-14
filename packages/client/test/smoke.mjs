/**
 * End-to-end check of the SDK against a running NoteFlare.
 *
 *   bun run build:client
 *   NOTEFLARE_URL=http://localhost:8787 NOTEFLARE_TOKEN=nf_… NOTEFLARE_READ_TOKEN=nf_… \
 *   NOTEFLARE_PASSPHRASE=… node packages/client/test/smoke.mjs
 *
 * Needs a write token and a read-only token for the same account, and an account
 * that has already been set up (passphrase chosen in the web app).
 */
import assert from 'node:assert/strict'
import { ConflictError, NoteFlareClient, NoteFlareError, WrongSecretError } from '../dist/index.js'

const url = process.env.NOTEFLARE_URL ?? 'http://localhost:8787'
const pass = process.env.NOTEFLARE_PASSPHRASE
const writer = () => new NoteFlareClient({ url, token: process.env.NOTEFLARE_TOKEN })
const reader = new NoteFlareClient({ url, token: process.env.NOTEFLARE_READ_TOKEN })

const step = async (name, fn) => {
  await fn()
  console.log('✓', name)
}

const a = writer()
const b = writer() // a second device

await step('me reports a write token', async () => {
  const me = await a.me()
  assert.equal(me.auth, 'token')
  assert.equal(me.scope, 'write')
  assert.equal(me.hasVault, true)
})

await step('wrong passphrase is rejected; reading before unlock fails clearly', async () => {
  await assert.rejects(a.unlock('not the passphrase'), WrongSecretError)
  await assert.rejects(a.list(), (e) => e instanceof NoteFlareError && e.code === 'locked')
})

await a.unlock(pass)
await b.unlock(pass)

let groceries
await step('list decrypts existing notes', async () => {
  const notes = await a.list()
  assert.ok(notes.length > 0)
  assert.ok(notes.every((n) => typeof n.title === 'string' && typeof n.body === 'string'))
})

await step('create, get, append', async () => {
  groceries = await a.create({ title: 'Groceries (from the SDK)', body: '- [ ] milk\n- [ ] eggs\n- [ ] bread', labels: ['sdk'] })
  assert.equal(groceries.version, 1)
  const again = await b.get(groceries.id)
  assert.equal(again.title, 'Groceries (from the SDK)')
  const appended = await b.append(groceries.id, '- [ ] coffee')
  assert.equal(appended.body.split('\n').length, 4)
})

await step('update() re-applies a change on the latest copy (no lost edit)', async () => {
  const n = await a.update(groceries.id, (cur) => ({ body: cur.body.replace('- [ ] milk', '- [x] milk') }))
  assert.equal(n.body, '- [x] milk\n- [ ] eggs\n- [ ] bread\n- [ ] coffee')
})

await step('save() merges a stale edit with a change from another device', async () => {
  const mine = await a.get(groceries.id) // A starts editing…
  await b.update(groceries.id, { labels: ['sdk', 'home'], body: (await b.get(groceries.id)).body + '\n- [ ] rice' }) // …B saves first
  const merged = await a.save({ ...mine, body: mine.body.replace('- [ ] eggs', '- [x] eggs') })
  assert.equal(merged.body, '- [x] milk\n- [x] eggs\n- [ ] bread\n- [ ] coffee\n- [ ] rice')
  assert.deepEqual(merged.labels, ['sdk', 'home'])
})

await step('save() throws ConflictError when the same line changed differently', async () => {
  const mine = await a.get(groceries.id)
  await b.update(groceries.id, { title: 'Groceries for Saturday' })
  await assert.rejects(a.save({ ...mine, title: 'Groceries for Sunday' }), (e) => {
    assert.ok(e instanceof ConflictError)
    assert.equal(e.theirs.title, 'Groceries for Saturday')
    assert.equal(e.mine.title, 'Groceries for Sunday')
    return true
  })
})

await step('changes(cursor) returns only newer notes', async () => {
  const { cursor } = await a.changes(0)
  const none = await a.changes(cursor)
  assert.equal(none.notes.length, 0)
  await b.append(groceries.id, '- [ ] tea')
  const some = await a.changes(cursor)
  assert.deepEqual(some.notes.map((n) => n.id), [groceries.id])
})

await step('a read-only token can read but not write', async () => {
  await reader.unlock(pass)
  assert.ok((await reader.get(groceries.id)).body.includes('tea'))
  await assert.rejects(reader.create({ title: 'nope' }), (e) => e instanceof NoteFlareError && e.status === 403)
})

await step('archive, trash, restore, delete forever', async () => {
  const tmp = await a.create({ title: 'Temporary' })
  assert.equal((await a.archive(tmp.id)).archived, true)
  assert.ok(!(await a.list()).some((n) => n.id === tmp.id))
  assert.ok((await a.list({ archived: true })).some((n) => n.id === tmp.id))
  assert.ok((await a.trash(tmp.id)).trashedAt)
  assert.equal((await a.restore(tmp.id)).trashedAt, null)
  await a.trash(tmp.id)
  await a.deleteForever(tmp.id)
  assert.ok(!(await a.ids()).some((x) => x.id === tmp.id))
})

await step('bad input is caught before it is sent', async () => {
  await assert.rejects(a.create({ title: 'x', color: 'neon' }), TypeError)
})

console.log(`\nAll SDK checks passed. Sample note: ${groceries.id}`)
