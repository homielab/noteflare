import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import type { EncryptedNote, VaultRecord } from '../shared/types'
import { ApiError } from '../src/lib/api'
import { decryptNote, encryptNote, unlockWithPassphrase } from '../src/lib/crypto'
import { emptyNote, toPayload } from '../src/lib/noteModel'
import { DEMO_PASSPHRASE } from '../src/lib/demo/content'
import { createDemoServer } from '../src/lib/demo/server'

let n = 0
const servers: ReturnType<typeof createDemoServer>[] = []
const newServer = (lang = 'en') => {
  const s = createDemoServer(`demo-test-${n++}`, () => lang)
  servers.push(s)
  return s
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.reset()))
})

describe('demo backend', () => {
  it('seeds a vault the demo passphrase unlocks and sample notes it decrypts', async () => {
    const s = newServer()
    expect(await s.handle('GET', '/me')).toMatchObject({ hasVault: true, attachments: false })
    const vault = (await s.handle('GET', '/vault')) as VaultRecord
    const dek = await unlockWithPassphrase(vault, DEMO_PASSPHRASE)
    const notes = (await s.handle('GET', '/notes?since=0')) as EncryptedNote[]
    expect(notes.length).toBeGreaterThan(5)
    expect(notes.some((x) => x.pinned)).toBe(true)
    expect(notes.some((x) => x.archived)).toBe(true)
    const first = await decryptNote(dek, notes[0].id, notes[0].ciphertext, notes[0].iv)
    expect(first.title).not.toBe('')
  })

  it('round-trips a note with the Worker version rules and survives a reopen', async () => {
    const name = `demo-test-${n++}`
    const s = createDemoServer(name)
    const dek = await unlockWithPassphrase((await s.handle('GET', '/vault')) as VaultRecord, DEMO_PASSPHRASE)
    const note = { ...emptyNote(), title: 'Mine', body: 'hello' }
    const enc = await encryptNote(dek, note.id, toPayload(note))
    const body = { ...enc, pinned: false, archived: false, trashedAt: null, position: 1 }

    const created = (await s.handle('PUT', `/notes/${note.id}`, { ...body, baseVersion: 0 })) as EncryptedNote
    expect(created.version).toBe(1)
    const stale = s.handle('PUT', `/notes/${note.id}`, { ...body, baseVersion: 0 })
    await expect(stale).rejects.toMatchObject({ status: 409 })
    const edited = (await s.handle('PUT', `/notes/${note.id}`, { ...body, pinned: true, baseVersion: 1 })) as EncryptedNote
    expect(edited).toMatchObject({ version: 2, pinned: true })

    // Another instance on the same database (a reload) sees it.
    const again = createDemoServer(name)
    servers.push(again)
    const rows = (await again.handle('GET', `/notes?since=${created.updatedAt}`)) as EncryptedNote[]
    const row = rows.find((r) => r.id === note.id)!
    expect((await decryptNote(dek, row.id, row.ciphertext, row.iv)).title).toBe('Mine')

    // Delete forever only from the trash.
    await expect(again.handle('DELETE', `/notes/${note.id}`)).rejects.toBeInstanceOf(ApiError)
    await again.handle('PUT', `/notes/${note.id}`, { ...body, trashedAt: 5, baseVersion: 2 })
    await again.handle('DELETE', `/notes/${note.id}`)
    const index = (await again.handle('GET', '/notes/index')) as { id: string }[]
    expect(index.some((x) => x.id === note.id)).toBe(false)
  })

  it('reset brings the sample notes back and server-only calls fail cleanly', async () => {
    const s = newServer('vi')
    const before = (await s.handle('GET', '/notes/index')) as { id: string }[]
    await s.reset()
    const after = (await s.handle('GET', '/notes/index')) as { id: string }[]
    expect(after.length).toBe(before.length)
    expect(after.map((x) => x.id)).not.toEqual(before.map((x) => x.id))
    expect(await s.handle('GET', '/backups')).toEqual({ backups: [] })
    await expect(s.handle('POST', '/shares', {})).rejects.toMatchObject({ status: 404 })
  })
})
