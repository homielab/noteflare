import { describe, expect, it } from 'vitest'
import { NoteFlareClient } from '../packages/client/src/client'
import { createVault, decryptNote, encryptNote } from '../packages/client/src/crypto'
import type { EncryptedNote, PutNoteBody } from '../shared/types'

const ID = '3f2b8c1e-1234-4abc-9def-0123456789ab'
const extra = { future: { kind: 'checklist', items: [1, 2] } }

/** A NoteFlare API with one account, enough for get / update / save. */
async function setup() {
  const { record, dek } = await createVault('pass-sdk-extra')
  const rows = new Map<string, EncryptedNote>()
  let clock = 1
  const put = (id: string, b: PutNoteBody) => {
    const cur = rows.get(id)
    if ((cur?.version ?? 0) !== b.baseVersion) return Response.json({ error: 'conflict', current: cur }, { status: 409 })
    const { baseVersion: _b, ...fields } = b
    const row = { id, ...fields, version: (cur?.version ?? 0) + 1, createdAt: cur?.createdAt ?? clock, updatedAt: ++clock }
    rows.set(id, row)
    return Response.json(row)
  }
  const fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/v1', '')
    if (path === '/vault') return Response.json(record)
    const id = path.split('/')[2]
    if (init.method === 'PUT') return put(id, JSON.parse(init.body as string))
    return Response.json(rows.get(id))
  }) as typeof globalThis.fetch
  const write = async (payload: Parameters<typeof encryptNote>[2]) => {
    const cur = rows.get(ID)
    put(ID, { ...(await encryptNote(dek, ID, payload)), pinned: false, archived: false, trashedAt: null, position: 1, baseVersion: cur?.version ?? 0 })
  }
  const read = () => decryptNote(dek, ID, rows.get(ID)!.ciphertext, rows.get(ID)!.iv)
  const client = new NoteFlareClient({ url: 'https://notes.test', token: 't', fetch })
  await client.unlock('pass-sdk-extra')
  return { client, write, read }
}

describe('SDK: fields from a newer app version', () => {
  it('keeps them when a note is edited', async () => {
    const { client, write, read } = await setup()
    await write({ title: 'Old', body: 'milk', color: 'default', labels: [], extra })
    const note = await client.update(ID, { title: 'New' })
    expect(await read()).toMatchObject({ title: 'New', body: 'milk', extra })
    expect('extra' in note).toBe(true)
  }, 30_000)

  it('keeps a change made elsewhere through a 409 retry', async () => {
    const { client, write, read } = await setup()
    await write({ title: 'Groceries', body: 'milk', color: 'default', labels: [], extra })
    const mine = await client.get(ID)
    const changed = { future: { kind: 'checklist', items: [1, 2, 3] } }
    await write({ title: 'Groceries', body: 'milk', color: 'default', labels: [], extra: changed })
    await client.save({ ...mine, title: 'Groceries – Saturday' })
    expect(await read()).toMatchObject({ title: 'Groceries – Saturday', extra: changed })
  }, 30_000)
})
