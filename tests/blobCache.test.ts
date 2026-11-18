import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/lib/api'
import { deleteAttachments, loadImage } from '../src/lib/attachments'
import { createBlobCache } from '../src/lib/blobCache'
import { createVault, encryptBlob } from '../src/lib/crypto'

const ID_A = '11111111-2222-4333-8444-555555555555'
let n = 0
const fresh = (maxFullBytes?: number) => createBlobCache(`blobs-test-${n++}`, { maxFullBytes })
const blob = (size: number, fill = 1) => new Uint8Array(size).fill(fill)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('on-device attachment cache', () => {
  it('serves a cached image without a request, also offline, and holds only ciphertext', async () => {
    const { dek } = await createVault('passphrase')
    const cache = fresh()
    const encrypted = await encryptBlob(dek, ID_A, new TextEncoder().encode('PNG-secret'), 'image/png')
    let requests = 0
    const online = {
      getBlob: async () => {
        requests++
        return encrypted
      },
      online: () => true,
      cache,
    }
    const offline = { getBlob: () => Promise.reject(new TypeError('Failed to fetch')), online: () => false, cache }

    await expect(loadImage(dek, ID_A, offline)).rejects.toMatchObject({ reason: 'offline' })
    expect(text((await loadImage(dek, ID_A, online)).bytes)).toBe('PNG-secret')
    expect(requests).toBe(1)
    expect(text((await loadImage(dek, ID_A, online)).bytes)).toBe('PNG-secret')
    expect(requests).toBe(1)
    expect(text((await loadImage(dek, ID_A, offline)).bytes)).toBe('PNG-secret')

    const kept = (await cache.get(ID_A))!
    expect([...kept]).toEqual([...encrypted])
    expect(text(kept)).not.toContain('secret')
  }, 30_000)

  it('does not keep what it cannot decrypt, and replaces a damaged copy', async () => {
    const { dek } = await createVault('passphrase')
    const other = (await createVault('another passphrase entirely')).dek
    const cache = fresh()
    const foreign = await encryptBlob(other, ID_A, blob(4), 'image/png')
    await expect(loadImage(dek, ID_A, { getBlob: async () => foreign, online: () => true, cache })).rejects.toMatchObject({ reason: 'undecryptable' })
    expect(await cache.get(ID_A)).toBeNull()

    await cache.put(ID_A, foreign, 'full')
    const good = await encryptBlob(dek, ID_A, blob(4), 'image/png')
    await loadImage(dek, ID_A, { getBlob: async () => good, online: () => true, cache })
    expect([...(await cache.get(ID_A))!]).toEqual([...good])
  }, 60_000)

  it('evicts the least recently used full images past the cap and always keeps thumbnails', async () => {
    const cache = fresh(100)
    await cache.put('thumb-1', blob(60), 'thumb')
    await cache.put('thumb-2', blob(60), 'thumb')
    await cache.put('a', blob(40), 'full')
    await cache.put('b', blob(40), 'full')
    expect(await cache.get('a')).not.toBeNull() // a is now more recent than b
    await cache.put('c', blob(40), 'full')
    expect(await cache.get('b')).toBeNull()
    expect(await cache.get('a')).not.toBeNull()
    expect(await cache.get('c')).not.toBeNull()

    await cache.put('d', blob(90), 'full') // needs both others out
    expect(await cache.get('a')).toBeNull()
    expect(await cache.get('c')).toBeNull()
    expect(await cache.get('d')).not.toBeNull()

    await cache.put('too-big', blob(101), 'full')
    expect(await cache.get('too-big')).toBeNull()
    expect(await cache.get('d')).not.toBeNull()

    // Thumbnails are over the cap on their own and were never touched.
    expect((await cache.get('thumb-1'))?.byteLength).toBe(60)
    expect((await cache.get('thumb-2'))?.byteLength).toBe(60)
  })

  it('forgets deleted attachments, and everything on sign-out', async () => {
    const cache = fresh()
    await cache.put('full', blob(8), 'full')
    await cache.put('thumb', blob(4), 'thumb')
    await cache.put('other', blob(4), 'thumb')
    deleteAttachments(['full', 'thumb'], { deleteBlob: () => Promise.reject(new ApiError(500, null)), cache })
    await expect.poll(() => cache.get('full')).toBeNull()
    expect(await cache.get('thumb')).toBeNull()
    expect(await cache.get('other')).not.toBeNull()

    await cache.destroy()
    expect(await cache.get('other')).toBeNull()
    const reopened = createBlobCache(`blobs-test-${n - 1}`)
    expect(await reopened.get('other')).toBeNull()
  })
})
