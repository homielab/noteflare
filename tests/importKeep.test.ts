import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { MAX_ATTACHMENT_BYTES } from '../shared/types'
import { parseKeepNote } from '../src/lib/importKeep'
import { attachImportImages, findMedia } from '../src/lib/importImages'
import { freshNotes, imageAlt, isImportablePath, isKeepPath, type ParsedNote } from '../src/lib/importMarkdown'

const keep = (o: object) => JSON.stringify({ isTrashed: false, isArchived: false, isPinned: false, ...o })

describe('parseKeepNote', () => {
  it('reads a text note with labels, color, pin and edit time', () => {
    const n = parseKeepNote(
      'Takeout/Keep/Trip.json',
      keep({ title: 'Trip', textContent: 'Book flights\r\nPack', labels: [{ name: 'travel' }], color: 'BLUE', isPinned: true, userEditedTimestampUsec: 1700000000000000 }),
    )
    expect(n).toMatchObject({ title: 'Trip', body: 'Book flights\nPack', labels: ['travel'], color: 'sky', pinned: true, archived: false })
    expect(n?.modifiedAt).toBe(1700000000000)
  })

  it('turns a list note into a checklist', () => {
    const n = parseKeepNote('a.json', keep({ title: 'Shop', listContent: [{ text: 'Milk', isChecked: true }, { text: 'Eggs', isChecked: false }] }))
    expect(n?.body).toBe('- [x] Milk\n- [ ] Eggs')
  })

  it('appends link previews that the text does not already contain', () => {
    const n = parseKeepNote(
      'a.json',
      keep({ textContent: 'see https://a.example', annotations: [{ url: 'https://a.example', title: 'A' }, { url: 'https://b.example', title: 'B [x]' }, { url: 'javascript:alert(1)' }] }),
    )
    expect(n?.body).toBe('see https://a.example\n\n[B x](https://b.example)')
  })

  it('skips trashed notes, empty notes, and JSON that is not a Keep note', () => {
    expect(parseKeepNote('a.json', keep({ title: 'x', textContent: 'y', isTrashed: true }))).toBeNull()
    expect(parseKeepNote('a.json', keep({ title: '', textContent: '  ' }))).toBeNull()
    expect(parseKeepNote('package.json', '{"name":"x","version":"1.0.0"}')).toBeNull()
    expect(parseKeepNote('a.json', 'not json')).toBeNull()
    expect(parseKeepNote('a.json', '[]')).toBeNull()
  })

  it('never pins an archived note and falls back to the default color', () => {
    const n = parseKeepNote('a.json', keep({ title: 't', textContent: 'b', isPinned: true, isArchived: true, color: 'DEFAULT' }))
    expect(n).toMatchObject({ pinned: false, archived: true, color: 'default' })
  })

  it('parses note with attachments from fixture and allows attachment-only notes', () => {
    const raw = readFileSync(new URL('./fixtures/keep/Receipts.json', import.meta.url), 'utf8')
    const n = parseKeepNote('Takeout/Keep/Receipts.json', raw)
    expect(n).not.toBeNull()
    expect(n?.images).toHaveLength(3)
    expect(n?.body).toBe('Paris trip')

    const onlyAttachments = parseKeepNote(
      'Takeout/Keep/only.json',
      keep({ attachments: [{ filePath: 'photo.png', mimetype: 'image/png' }] }),
    )
    expect(onlyAttachments).not.toBeNull()
    expect(onlyAttachments?.images).toHaveLength(1)
  })
})

describe('attachImportImages', () => {
  const raw = readFileSync(new URL('./fixtures/keep/Receipts.json', import.meta.url), 'utf8')
  const fixtureNote = parseKeepNote('Takeout/Keep/Receipts.json', raw)!
  const photo1 = new File([readFileSync(new URL('./fixtures/keep/photo-1.png', import.meta.url))], 'photo-1.png', { type: 'image/png' })
  const photo2 = new File([readFileSync(new URL('./fixtures/keep/photo-2.jpg', import.meta.url))], 'photo-2.jpg', { type: 'image/jpeg' })
  const media = new Map<string, File>([
    ['Takeout/Keep/photo-1.png', photo1],
    ['Takeout/Keep/photo-2.jpg', photo2],
  ])

  it('uploads images in order and appends markdown links', async () => {
    const upload = vi.fn(async (file: File) => `![${imageAlt(file.name)}](/api/blobs/${crypto.randomUUID()}#w=1&h=1)`)
    const res = await attachImportImages([fixtureNote], {
      enabled: true,
      find: (note, name) => findMedia(media, note.sourcePath, name),
      upload,
    })
    expect(res.notes).toHaveLength(1)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(upload.mock.calls[0][0].type).toBe('image/png')
    expect(upload.mock.calls[1][0].type).toBe('image/jpeg')
    expect(res.skips).toEqual({ off: 0, missing: 0, tooLarge: 0, unsupported: 1, failed: 0 })
    const body = res.notes[0].body
    expect(body).toMatch(/^Paris trip\n\n!\[photo-1\]\(\/api\/blobs\/[0-9a-f-]{36}#w=1&h=1\)\n\n!\[photo-2\]\(\/api\/blobs\/[0-9a-f-]{36}#w=1&h=1\)$/)
  })

  it('skips uploading when storage is off and drops notes left empty', async () => {
    const upload = vi.fn()
    const res = await attachImportImages([fixtureNote], {
      enabled: false,
      find: (note, name) => findMedia(media, note.sourcePath, name),
      upload,
    })
    expect(upload).not.toHaveBeenCalled()
    expect(res.notes).toHaveLength(1)
    expect(res.notes[0].body).toBe('Paris trip')
    expect(res.skips).toEqual({ off: 2, missing: 0, tooLarge: 0, unsupported: 1, failed: 0 })

    const emptyNoteWithImage: ParsedNote = {
      title: '',
      body: '',
      color: 'default',
      labels: [],
      pinned: false,
      archived: false,
      modifiedAt: 1,
      sourcePath: 'Takeout/Keep/empty.json',
      images: [{ name: 'photo-1.png', type: 'image/png' }],
    }
    const resEmpty = await attachImportImages([emptyNoteWithImage], {
      enabled: false,
      find: (note, name) => findMedia(media, note.sourcePath, name),
      upload,
    })
    expect(resEmpty.notes).toHaveLength(0)
  })

  it('handles missing files, files that are too large, and upload failures', async () => {
    const upload = vi.fn(async () => '![img](/api/blobs/x)')
    // missing file
    const resMissing = await attachImportImages([fixtureNote], {
      enabled: true,
      find: () => undefined,
      upload,
    })
    expect(resMissing.skips.missing).toBe(2)

    // too large
    const largeFile = new File(['a'], 'photo-1.png', { type: 'image/png' })
    Object.defineProperty(largeFile, 'size', { value: MAX_ATTACHMENT_BYTES + 1 })
    const resLarge = await attachImportImages([fixtureNote], {
      enabled: true,
      find: () => largeFile,
      upload,
    })
    expect(resLarge.skips.tooLarge).toBe(2)

    // upload rejecting
    const failUpload = vi.fn().mockRejectedValue(new Error('upload failed'))
    const resFailed = await attachImportImages([fixtureNote], {
      enabled: true,
      find: (note, name) => findMedia(media, note.sourcePath, name),
      upload: failUpload,
    })
    expect(resFailed.skips.failed).toBe(2)
    expect(resFailed.notes).toHaveLength(1)
    expect(resFailed.notes[0].body).toBe('Paris trip')
  })

  it('deduplicates notes correctly in freshNotes', async () => {
    const upload = vi.fn(async (file: File) => `![${imageAlt(file.name)}](/api/blobs/${crypto.randomUUID()}#w=1&h=1)`)
    const uploadedNote = (await attachImportImages([fixtureNote], {
      enabled: true,
      find: (note, name) => findMedia(media, note.sourcePath, name),
      upload,
    })).notes[0]

    // (a) parsed fixture against note with uploaded images -> empty
    expect(freshNotes([fixtureNote], [uploadedNote])).toEqual([])

    // (b) against text-only note -> empty
    expect(freshNotes([fixtureNote], [{ title: 'Receipts', body: 'Paris trip' }])).toEqual([])

    // an earlier import that could upload only one of the two images
    const partial = { title: 'Receipts', body: uploadedNote.body.split('\n\n').slice(0, 2).join('\n\n') }
    expect(freshNotes([fixtureNote], [partial])).toEqual([])
    // the same text with a different image is another note
    const other = { title: 'Receipts', body: `Paris trip\n\n![elsewhere](/api/blobs/${crypto.randomUUID()})` }
    expect(freshNotes([fixtureNote], [other])).toEqual([fixtureNote])

    // (c) two image-only notes with different image names -> both fresh; same one twice -> one
    const imgNote1: ParsedNote = {
      title: '',
      body: '',
      color: 'default',
      labels: [],
      pinned: false,
      archived: false,
      modifiedAt: 1,
      sourcePath: '1.json',
      images: [{ name: 'a.png', type: 'image/png' }],
    }
    const imgNote2: ParsedNote = {
      title: '',
      body: '',
      color: 'default',
      labels: [],
      pinned: false,
      archived: false,
      modifiedAt: 1,
      sourcePath: '2.json',
      images: [{ name: 'b.png', type: 'image/png' }],
    }
    expect(freshNotes([imgNote1, imgNote2], [])).toHaveLength(2)
    expect(freshNotes([imgNote1, imgNote1], [])).toHaveLength(1)

    // (d) notes without images behave as before
    const plain1: ParsedNote = { title: 'T', body: 'B', color: 'default', labels: [], pinned: false, archived: false, modifiedAt: 1, sourcePath: 'p1.md' }
    const plain2: ParsedNote = { title: 'T', body: 'B', color: 'default', labels: [], pinned: false, archived: false, modifiedAt: 1, sourcePath: 'p2.md' }
    const plain3: ParsedNote = { title: 'T', body: 'Other', color: 'default', labels: [], pinned: false, archived: false, modifiedAt: 1, sourcePath: 'p3.md' }
    expect(freshNotes([plain1, plain2, plain3], [plain1])).toEqual([plain3])
  })
})

describe('import paths', () => {
  it('accepts Markdown and JSON, but not tool folders', () => {
    expect(isImportablePath('Takeout/Keep/a.json')).toBe(true)
    expect(isKeepPath('Takeout/Keep/a.json')).toBe(true)
    expect(isImportablePath('Vault/a.md')).toBe(true)
    expect(isKeepPath('Vault/a.md')).toBe(false)
    expect(isImportablePath('Vault/node_modules/x/package.json')).toBe(false)
    expect(isImportablePath('Takeout/Keep/a.html')).toBe(false)
    expect(isImportablePath('Takeout/Keep/a.jpg')).toBe(true)
  })
})
