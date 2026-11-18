import { describe, expect, it, vi } from 'vitest'
import worker from '../worker/index'
import { createVault, decryptBlob, encryptBlob } from '../src/lib/crypto'
import {
  attachmentDownloadName,
  attachmentExportName,
  attachmentIdOf,
  attachmentBlobIds,
  attachmentIds,
  attachmentSize,
  attachmentThumbId,
  attachmentUrl,
  deleteAttachments,
  gridSource,
  loadGridImage,
  loadImage,
  rewriteAttachments,
  unusedAttachments,
  uploadAttachment,
} from '../src/lib/attachments'
import { ApiError } from '../src/lib/api'
import { markdownEntries } from '../src/lib/exportNotes'
import { emptyNote } from '../src/lib/noteModel'
import { MAX_ATTACHMENT_BYTES } from '../shared/types'

// Only exists inside the Workers runtime.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

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

describe('file attachments', () => {
  it('hides the name, type and content of a file and gives them back', async () => {
    const { dek } = await createVault('passphrase')
    const blob = await encryptBlob(dek, ID_A, bytes('%PDF-secret'), 'application/pdf', 'tax report.pdf')
    for (const hidden of ['tax report', 'application/pdf', 'secret']) expect(text(blob)).not.toContain(hidden)
    const back = await decryptBlob(dek, ID_A, blob)
    expect(text(back.bytes)).toBe('%PDF-secret')
    expect(back.file).toEqual({ name: 'tax report.pdf', type: 'application/pdf' })
    await expect(decryptBlob(dek, ID_B, blob)).rejects.toThrow()
  })

  it('never reports a file as something to display, whatever it claims to be', async () => {
    const { dek } = await createVault('passphrase')
    for (const type of ['image/png', 'text/html']) {
      const back = await decryptBlob(dek, ID_A, await encryptBlob(dek, ID_A, bytes('<script>'), type, 'x.html'))
      expect(back.type).toBe('application/octet-stream')
    }
  })

  it('still reads images, which carry no name', async () => {
    const { dek } = await createVault('passphrase')
    const back = await decryptBlob(dek, ID_A, await encryptBlob(dek, ID_A, bytes('PNG'), 'image/png'))
    expect(back).toMatchObject({ type: 'image/png' })
    expect(back.file).toBeUndefined()
    expect(text(back.bytes)).toBe('PNG')
  })

  it('refuses a file whose header runs past its end', async () => {
    const { dek } = await createVault('passphrase')
    const iv = new Uint8Array(12)
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bytes(`blob:${ID_A}`) }, dek, new Uint8Array([0, 0xff, 0xff, 1]))
    await expect(decryptBlob(dek, ID_A, new Uint8Array([...iv, ...new Uint8Array(ct)]))).rejects.toThrow()
  })

  it('saves and exports under names that cannot leave their folder', () => {
    const file = (name: string) => ({ bytes: bytes(''), type: 'application/octet-stream', file: { name, type: '' } })
    const saved = attachmentDownloadName(file('../../.ssh/evil key.pdf'))
    expect(saved).not.toMatch(/[\\/]|^\./)
    expect(saved.endsWith('evil key.pdf')).toBe(true)
    expect(attachmentDownloadName(file(''), 'notes')).toBe('notes')
    expect(attachmentDownloadName({ bytes: bytes(''), type: 'image/png' }, 'photo')).toBe('photo.png')
    expect(attachmentExportName(ID_A, file('../a/b.PDF'))).toBe(`${ID_A}.pdf`)
    expect(attachmentExportName(ID_A, file('no extension/..'))).toBe(`${ID_A}.bin`)
    expect(attachmentExportName(ID_A, { bytes: bytes(''), type: 'image/jpeg' })).toBe(`${ID_A}.jpg`)
  })
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
  // An empty settings table: no saved Access setup.
  const DB = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) }
  const env = (user: string, store?: ReturnType<typeof bucket>) =>
    ({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', DEV_USER_EMAIL: user, ATTACHMENTS: store, DB }) as never
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
    expect((await call(me, 'PUT', ID_A, new Uint8Array(MAX_ATTACHMENT_BYTES + 8192))).status).toBe(413)
  })

  it('answers 501 when the deployment has no bucket, and stays locked without a session', async () => {
    expect((await call(env('me@example.com'), 'PUT', ID_A, bytes('x'))).status).toBe(501)
    expect((await call(env('me@example.com'), 'GET', ID_A)).status).toBe(501)
    expect((await call(env('', bucket()), 'GET', ID_A)).status).toBe(401)
  })
})

describe('why an image did not load', () => {
  const online = (v: boolean) => () => v
  const failing = (err: unknown, on = true) => ({ getBlob: () => Promise.reject(err), online: online(on) })

  it('tells deleted, storage off, server errors and offline apart', async () => {
    const { dek } = await createVault('passphrase')
    await expect(loadImage(dek, ID_A, failing(new ApiError(404, { error: 'not_found' })))).rejects.toMatchObject({ reason: 'deleted' })
    await expect(loadImage(dek, ID_A, failing(new ApiError(501, { error: 'attachments_disabled' })))).rejects.toMatchObject({ reason: 'disabled' })
    await expect(loadImage(dek, ID_A, failing(new ApiError(500, null)))).rejects.toMatchObject({ reason: 'network' })
    await expect(loadImage(dek, ID_A, failing(new TypeError('Failed to fetch'), false))).rejects.toMatchObject({ reason: 'offline' })
    await expect(loadImage(dek, ID_A, failing(new TypeError('Failed to fetch'), true))).rejects.toMatchObject({ reason: 'network' })
  }, 30_000)

  it('reports a blob it cannot read or show as undecryptable, and loads a good image', async () => {
    const { dek } = await createVault('passphrase')
    const other = (await createVault('another passphrase entirely')).dek
    const serve = (blob: Uint8Array) => ({ getBlob: () => Promise.resolve(blob), online: online(true) })
    await expect(loadImage(dek, ID_A, serve(await encryptBlob(other, ID_A, bytes('x'), 'image/png')))).rejects.toMatchObject({ reason: 'undecryptable' })
    await expect(loadImage(dek, ID_A, serve(await encryptBlob(dek, ID_A, bytes('x'), 'application/pdf', 'a.pdf')))).rejects.toMatchObject({
      reason: 'undecryptable',
    })
    expect((await loadImage(dek, ID_A, serve(await encryptBlob(dek, ID_A, bytes('PNG'), 'image/png')))).type).toBe('image/png')
  }, 60_000)
})

describe('attachment links with a size fragment', () => {
  const plain = `/api/blobs/${ID_A}`

  it('reads the same id with and without the fragment, and rejects other paths', () => {
    expect(attachmentIdOf(`${plain}#w=800&h=600`)).toBe(ID_A)
    expect(attachmentIdOf(plain)).toBe(ID_A)
    expect(attachmentIdOf(`${plain}#w=800&h=600&t=abc`)).toBe(ID_A)
    expect(attachmentIdOf(`/api/blobs/${ID_A}/extra#w=1`)).toBeNull()
  })

  it('reads the size only when both sides are valid whole numbers', () => {
    expect(attachmentSize(`${plain}#w=800&h=600`)).toEqual({ w: 800, h: 600 })
    expect(attachmentSize(`${plain}#h=600&w=800&t=abc`)).toEqual({ w: 800, h: 600 })
    for (const bad of [plain, `${plain}#w=0&h=600`, `${plain}#w=abc&h=1`, `${plain}#w=800`, `${plain}#w=1.5&h=2`, `${plain}#w=100001&h=2`])
      expect(attachmentSize(bad)).toBeNull()
  })

  it('round-trips through attachmentUrl', () => {
    const url = attachmentUrl(ID_A, { w: 800, h: 600 })
    expect(attachmentIdOf(url)).toBe(ID_A)
    expect(attachmentSize(url)).toEqual({ w: 800, h: 600 })
    expect(attachmentUrl(ID_A)).toBe(plain)
  })

  it('lists, rewrites, cleans up and exports the same with or without it', () => {
    const body = `![a](${plain}#w=800&h=600)\n![b](/api/blobs/${ID_B})\n![a again](${plain})`
    expect(attachmentIds(body)).toEqual([ID_A, ID_B])
    expect(rewriteAttachments(`![a](${plain}#w=800&h=600)`, () => 'a.png')).toBe('![a](a.png)')
    const unused = (deleted: string, other: string) => {
      const used = new Set(attachmentIds(other))
      return attachmentIds(deleted).filter((id) => !used.has(id))
    }
    expect(unused(`![a](${plain}#w=1&h=1)`, `![a](${plain})`)).toEqual([])
    expect(unused(`![a](${plain})`, `![a](${plain}#w=1&h=1)`)).toEqual([])
    expect(unused(`![a](${plain}#w=1&h=1)`, 'nothing')).toEqual([ID_A])
    const file = markdownEntries([{ ...emptyNote(), title: 'N', body: `![a](${plain}#w=800&h=600)` }], 'NoteFlare', new Map([[ID_A, 'x.png']]))
    expect(text(file[0].data)).toContain('![a](attachments/x.png)')
  })
})

describe('thumbnails', () => {
  /** A server and a device cache that only remember what they were given. */
  const world = () => {
    const server = new Map<string, Uint8Array>()
    const device = new Map<string, string>()
    return {
      server,
      device,
      failPut: (_id: string) => false,
      deps(info: { size?: { w: number; h: number }; thumb?: { bytes: Uint8Array; type: string } } | Error) {
        return {
          putBlob: async (id: string, data: Uint8Array) => {
            if (this.failPut(id)) throw new ApiError(500, null)
            server.set(id, data)
          },
          deleteBlob: async (id: string) => void server.delete(id),
          inspect: async () => {
            if (info instanceof Error) throw info
            return info
          },
          cache: {
            put: async (id: string, _data: Uint8Array, kind: string) => void device.set(id, kind),
            delete: async (ids: string[]) => ids.forEach((id) => device.delete(id)),
          },
        }
      },
    }
  }
  const photo = () => new File([bytes('FULL-IMAGE')], 'holiday.png', { type: 'image/png' })
  const srcOf = (markdown: string) => /\]\((.*)\)$/.exec(markdown)![1]
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('stores the image and its thumbnail as two encrypted blobs and names the thumbnail in the link', async () => {
    const { dek } = await createVault('passphrase')
    const w = world()
    const src = srcOf(await uploadAttachment(dek, photo(), undefined, w.deps({ size: { w: 800, h: 600 }, thumb: { bytes: bytes('SMALL'), type: 'image/webp' } })))
    const id = attachmentIdOf(src)!
    const thumb = attachmentThumbId(src)!
    expect(thumb).not.toBe(id)
    expect([...w.server.keys()].sort()).toEqual([id, thumb].sort())
    expect(attachmentSize(src)).toEqual({ w: 800, h: 600 })
    expect(text((await decryptBlob(dek, id, w.server.get(id)!)).bytes)).toBe('FULL-IMAGE')
    const small = await decryptBlob(dek, thumb, w.server.get(thumb)!)
    expect(small.type).toBe('image/webp')
    expect(text(small.bytes)).toBe('SMALL')
    expect(text(w.server.get(thumb)!)).not.toContain('SMALL')
    // Both are on the device from now on, the thumbnail as one that is always kept.
    expect(w.device.get(id)).toBe('full')
    expect(w.device.get(thumb)).toBe('thumb')
  }, 30_000)

  it('still gives a working link when the thumbnail cannot be made or stored', async () => {
    const { dek } = await createVault('passphrase')
    const cases = [world(), world(), world()]
    cases[2].failPut = (id) => cases[2].server.size > 0 && !cases[2].server.has(id) // the second blob fails
    const links = [
      await uploadAttachment(dek, photo(), undefined, cases[0].deps(new Error('no canvas'))),
      await uploadAttachment(dek, photo(), undefined, cases[1].deps({ size: { w: 100, h: 50 } })),
      await uploadAttachment(dek, photo(), undefined, cases[2].deps({ size: { w: 800, h: 600 }, thumb: { bytes: bytes('SMALL'), type: 'image/webp' } })),
    ]
    for (const [i, link] of links.entries()) {
      const src = srcOf(link)
      const id = attachmentIdOf(src)!
      expect(attachmentThumbId(src)).toBeNull()
      expect([...cases[i].server.keys()]).toEqual([id])
      expect(gridSource(src)).toEqual({ id, kind: 'full', full: id })
    }
  }, 30_000)

  it('uses the full image for a link without a thumbnail, or whose thumbnail is gone', async () => {
    const { dek } = await createVault('passphrase')
    const plain = `/api/blobs/${ID_A}`
    expect(gridSource(plain)).toEqual({ id: ID_A, kind: 'full', full: ID_A })
    expect(gridSource(`${plain}#w=8&h=6`)).toEqual({ id: ID_A, kind: 'full', full: ID_A })
    expect(gridSource(`${plain}#w=8&h=6&t=not-an-id`)).toEqual({ id: ID_A, kind: 'full', full: ID_A })
    expect(gridSource(`${plain}#w=8&h=6&t=${ID_B}`)).toEqual({ id: ID_B, kind: 'thumb', full: ID_A })
    expect(gridSource('https://example.com/a.png')).toBeNull()
    expect(attachmentUrl(ID_A, { w: 8, h: 6 }, ID_B)).toBe(`${plain}#w=8&h=6&t=${ID_B}`)
    expect(attachmentUrl(ID_A, undefined, ID_B)).toBe(`${plain}#t=${ID_B}`)

    const stored = new Map([
      [ID_A, await encryptBlob(dek, ID_A, bytes('FULL'), 'image/png')],
      [ID_B, await encryptBlob(dek, ID_B, bytes('SMALL'), 'image/webp')],
    ])
    const deps = {
      getBlob: async (id: string) => stored.get(id) ?? Promise.reject(new ApiError(404, null)),
      online: () => true,
      cache: { get: async () => null, put: async () => {}, delete: async () => {} },
    }
    expect(text((await loadGridImage(dek, `${plain}#t=${ID_B}`, deps)).bytes)).toBe('SMALL')
    expect(text((await loadGridImage(dek, plain, deps)).bytes)).toBe('FULL')
    stored.delete(ID_B)
    expect(text((await loadGridImage(dek, `${plain}#t=${ID_B}`, deps)).bytes)).toBe('FULL')
  }, 30_000)

  it('deletes the image and its thumbnail with the last note that uses the image, not before', async () => {
    const w = world()
    w.server.set(ID_A, bytes('full'))
    w.server.set(ID_B, bytes('thumb'))
    w.device.set(ID_A, 'full')
    w.device.set(ID_B, 'thumb')
    const body = `![a](/api/blobs/${ID_A}#w=800&h=600&t=${ID_B})`
    expect(attachmentBlobIds(body)).toEqual([ID_A, ID_B])
    expect(attachmentIds(body)).toEqual([ID_A]) // exports carry the full image only

    expect(unusedAttachments([body], [`a copy: ${body}`])).toEqual([])
    expect(unusedAttachments([body], [`![a](/api/blobs/${ID_A})`])).toEqual([ID_B])
    const unused = unusedAttachments([body, body], ['another note'])
    expect(unused).toEqual([ID_A, ID_B])
    deleteAttachments(unused, w.deps({}))
    await settle()
    expect(w.server.size).toBe(0)
    expect(w.device.size).toBe(0)
  })
})
