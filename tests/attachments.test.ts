import { describe, expect, it } from 'vitest'
import worker from '../worker/index'
import { createVault, decryptBlob, encryptBlob } from '../src/lib/crypto'
import { attachmentIdOf, attachmentIds, rewriteAttachments } from '../src/lib/attachments'
import { markdownEntries } from '../src/lib/exportNotes'
import { emptyNote } from '../src/lib/noteModel'
import { MAX_ATTACHMENT_BYTES } from '../shared/types'

const ID_A = '11111111-2222-4333-8444-555555555555'
const ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('attachment encryption', () => {
  it('round-trips the image and its type, and hides both from the server', async () => {
    const { dek } = await createVault('correct horse battery staple')
    const blob = await encryptBlob(dek, ID_A, bytes('PNGDATA-secret'), 'image/png')
    expect(text(blob)).not.toContain('image/png')
    expect(text(blob)).not.toContain('secret')
    const back = await decryptBlob(dek, ID_A, blob)
    expect(back.type).toBe('image/png')
    expect(text(back.bytes)).toBe('PNGDATA-secret')
  }, 30_000)

  it('refuses a blob served under another id, a tampered blob and another key', async () => {
    const { dek } = await createVault('correct horse battery staple')
    const other = (await createVault('another passphrase entirely')).dek
    const blob = await encryptBlob(dek, ID_A, bytes('x'), 'image/png')
    await expect(decryptBlob(dek, ID_B, blob)).rejects.toThrow()
    await expect(decryptBlob(other, ID_A, blob)).rejects.toThrow()
    const tampered = blob.slice()
    tampered[tampered.length - 1] ^= 1
    await expect(decryptBlob(dek, ID_A, tampered)).rejects.toThrow()
  }, 60_000)

  it('never reports a type that is not an accepted image', async () => {
    const { dek } = await createVault('correct horse battery staple')
    const blob = await encryptBlob(dek, ID_A, bytes('<svg onload=alert(1)>'), 'image/svg+xml')
    expect((await decryptBlob(dek, ID_A, blob)).type).toBe('application/octet-stream')
  }, 30_000)
})

describe('attachment links', () => {
  const body = `![a](/api/blobs/${ID_A}) text ![b](/api/blobs/${ID_B.toUpperCase()}) ![a again](/api/blobs/${ID_A}) ![x](https://example.com/api/blobs/nope)`

  it('finds each attachment once', () => {
    expect(attachmentIds(body)).toEqual([ID_A, ID_B])
    expect(attachmentIds('no images')).toEqual([])
  })

  it('recognises only an exact attachment URL as an image source', () => {
    expect(attachmentIdOf(`/api/blobs/${ID_A}`)).toBe(ID_A)
    expect(attachmentIdOf(`https://evil.example/api/blobs/${ID_A}`)).toBeNull()
    expect(attachmentIdOf(`/api/blobs/${ID_A}/extra`)).toBeNull()
    expect(attachmentIdOf(undefined)).toBeNull()
  })

  it('rewrites links, leaving unknown ones alone', () => {
    expect(rewriteAttachments(`![a](/api/blobs/${ID_A}) ![b](/api/blobs/${ID_B})`, (id) => (id === ID_A ? 'a.png' : undefined))).toBe(
      `![a](a.png) ![b](/api/blobs/${ID_B})`,
    )
  })

  it('exports with paths relative to each note file', () => {
    const names = new Map([[ID_A, `${ID_A}.png`]])
    const files = markdownEntries(
      [
        { ...emptyNote(), title: 'Top', body: `![a](/api/blobs/${ID_A})` },
        { ...emptyNote(), title: 'Deep', labels: ['work/q4'], body: `![a](/api/blobs/${ID_A})` },
      ],
      'NoteFlare',
      names,
    )
    expect(text(files[0].data)).toContain(`![a](attachments/${ID_A}.png)`)
    expect(text(files[1].data)).toContain(`![a](../../attachments/${ID_A}.png)`)
  })
})

describe('attachment routes', () => {
  /** Just enough of an R2 bucket for the routes. */
  const bucket = () => {
    const objects = new Map<string, ArrayBuffer>()
    return {
      objects,
      put: async (key: string, value: ArrayBuffer) => void objects.set(key, value),
      get: async (key: string) => {
        const value = objects.get(key)
        return value ? { body: value, size: value.byteLength } : null
      },
      delete: async (key: string) => void objects.delete(key),
    }
  }
  // Local requests with DEV_USER_EMAIL stand in for a Cloudflare Access session.
  const env = (user: string, store?: ReturnType<typeof bucket>) =>
    ({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: user, ATTACHMENTS: store }) as never
  const call = (e: never, method: string, id: string, body?: Uint8Array<ArrayBuffer>) =>
    worker.fetch(new Request(`http://localhost/api/blobs/${id}`, { method, body }) as never, e, {} as never)

  it('stores, returns and deletes a blob for its owner only', async () => {
    const store = bucket()
    const me = env('me@example.com', store)
    const put = await call(me, 'PUT', ID_A, bytes('ciphertext'))
    expect(put.status).toBe(201)
    expect([...store.objects.keys()]).toEqual([`me@example.com/${ID_A}`])

    const got = await call(me, 'GET', ID_A)
    expect(got.status).toBe(200)
    expect(got.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')
    expect(got.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(text(new Uint8Array(await got.arrayBuffer()))).toBe('ciphertext')

    expect((await call(env('other@example.com', store), 'GET', ID_A)).status).toBe(404)
    expect((await call(env('other@example.com', store), 'DELETE', ID_A)).status).toBe(204)
    expect(store.objects.size).toBe(1)

    expect((await call(me, 'DELETE', ID_A)).status).toBe(204)
    expect((await call(me, 'GET', ID_A)).status).toBe(404)
  })

  it('rejects bad ids, empty and oversized bodies', async () => {
    const me = env('me@example.com', bucket())
    expect((await call(me, 'PUT', 'not-an-id', bytes('x'))).status).toBe(400)
    expect((await call(me, 'PUT', ID_A)).status).toBe(400)
    expect((await call(me, 'PUT', ID_A, new Uint8Array(MAX_ATTACHMENT_BYTES + 1024))).status).toBe(413)
  })

  it('answers 501 when the deployment has no bucket, and stays locked without a session', async () => {
    expect((await call(env('me@example.com'), 'PUT', ID_A, bytes('x'))).status).toBe(501)
    expect((await call(env('me@example.com'), 'GET', ID_A)).status).toBe(501)
    expect((await call(env('', bucket()), 'GET', ID_A)).status).toBe(401)
  })
})
