import { describe, expect, it, vi } from 'vitest'
import { emptyNote } from '../src/lib/noteModel'
import { filterLibrary, libraryLabels, scanLibrary } from '../src/lib/library'
import { createInView } from '../src/lib/inView'

const ID_A = '11111111-2222-4333-8444-555555555555'
const ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const ID_C = '33333333-3333-4333-8333-333333333333'

describe('library scan', () => {
  it('distinguishes images and files, parsing name and size while ignoring external links', () => {
    const note = {
      ...emptyNote(),
      body: `![cat](/api/blobs/${ID_A})\n[report.pdf (1.2 MB)](/api/blobs/${ID_B})\n[x](https://example.com)\n![ext](https://example.com/pic.png)`,
    }
    const lib = scanLibrary([note])
    expect(lib.images).toHaveLength(1)
    expect(lib.images[0]).toMatchObject({
      id: ID_A,
      kind: 'image',
      name: 'cat',
      size: null,
      src: `/api/blobs/${ID_A}`,
      notes: [note],
    })
    expect(lib.files).toHaveLength(1)
    expect(lib.files[0]).toMatchObject({
      id: ID_B,
      kind: 'file',
      name: 'report.pdf',
      size: '1.2 MB',
      src: `/api/blobs/${ID_B}`,
      notes: [note],
    })
  })

  it('keeps link fragments and prefers the link with thumbnail parameter t=', () => {
    const note1 = {
      ...emptyNote(),
      createdAt: 100,
      body: `![a](/api/blobs/${ID_A})`,
    }
    const note2 = {
      ...emptyNote(),
      createdAt: 200,
      body: `![a](/api/blobs/${ID_A}#w=800&h=600&t=${ID_B})`,
    }
    const lib1 = scanLibrary([note1, note2])
    expect(lib1.images).toHaveLength(1)
    expect(lib1.images[0].src).toBe(`/api/blobs/${ID_A}#w=800&h=600&t=${ID_B}`)

    // When the note without thumbnail is newer, scanning still keeps t= once seen
    const note3 = {
      ...emptyNote(),
      createdAt: 300,
      body: `![a](/api/blobs/${ID_A})`,
    }
    const lib2 = scanLibrary([note2, note3])
    expect(lib2.images[0].src).toBe(`/api/blobs/${ID_A}#w=800&h=600&t=${ID_B}`)
  })

  it('deduplicates items across notes and within a single note', () => {
    const note1 = {
      ...emptyNote(),
      id: 'note-1',
      createdAt: 200,
      body: `![cat](/api/blobs/${ID_A})\n![cat](/api/blobs/${ID_A})`,
    }
    const note2 = {
      ...emptyNote(),
      id: 'note-2',
      createdAt: 100,
      body: `![cat](/api/blobs/${ID_A})`,
    }
    const lib = scanLibrary([note1, note2])
    expect(lib.images).toHaveLength(1)
    expect(lib.images[0].notes).toEqual([note1, note2])
  })

  it('excludes trashed notes and includes archived notes', () => {
    const trashed = {
      ...emptyNote(),
      id: 'trashed',
      trashedAt: 123456,
      body: `![trash](/api/blobs/${ID_A})`,
    }
    const archived = {
      ...emptyNote(),
      id: 'archived',
      archived: true,
      trashedAt: null,
      body: `![archive](/api/blobs/${ID_B})`,
    }
    const lib = scanLibrary([trashed, archived])
    expect(lib.images).toHaveLength(1)
    expect(lib.images[0].id).toBe(ID_B)
  })

  it('orders items by the newest note first', () => {
    const older = {
      ...emptyNote(),
      createdAt: 1000,
      body: `![old](/api/blobs/${ID_A})`,
    }
    const newer = {
      ...emptyNote(),
      createdAt: 2000,
      body: `![new](/api/blobs/${ID_B})`,
    }
    const lib = scanLibrary([older, newer])
    expect(lib.images.map((i) => i.id)).toEqual([ID_B, ID_A])
  })

  it('filters items by query and label, and extracts unique sorted labels', () => {
    const note1 = {
      ...emptyNote(),
      id: 'n1',
      title: 'Meeting Notes',
      body: `![sunset](/api/blobs/${ID_A})`,
      labels: ['personal', 'work'],
    }
    const note2 = {
      ...emptyNote(),
      id: 'n2',
      title: 'Doc',
      body: `Check this secret detail: [spec.pdf (500 KB)](/api/blobs/${ID_B})`,
      labels: ['work'],
    }
    const note3 = {
      ...emptyNote(),
      id: 'n3',
      title: 'Random',
      body: `![cat](/api/blobs/${ID_C})`,
      labels: ['animals'],
    }
    const lib = scanLibrary([note1, note2, note3])
    const allItems = [...lib.images, ...lib.files]

    // Query matches image name
    expect(filterLibrary(allItems, { query: 'sunset' })).toEqual([lib.images.find((i) => i.id === ID_A)])
    // Query matches note title
    expect(filterLibrary(allItems, { query: 'meeting' })).toEqual([lib.images.find((i) => i.id === ID_A)])
    // Query matches note body
    expect(filterLibrary(allItems, { query: 'secret' })).toEqual([lib.files.find((i) => i.id === ID_B)])
    // No match
    expect(filterLibrary(allItems, { query: 'nonexistent' })).toEqual([])

    // Label filter
    const workItems = filterLibrary(allItems, { label: 'work' })
    expect(workItems.map((i) => i.id)).toEqual([ID_A, ID_B])

    // Label + query together
    expect(filterLibrary(allItems, { label: 'work', query: 'sunset' }).map((i) => i.id)).toEqual([ID_A])
    expect(filterLibrary(allItems, { label: 'work', query: 'cat' })).toEqual([])

    // libraryLabels
    expect(libraryLabels(allItems)).toEqual(['animals', 'personal', 'work'])
  })
})

describe('inView lazy loader', () => {
  it('observes and unobserves targets on intersection and cleans up', () => {
    let capturedCb: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | undefined
    const observedSet = new Set<Element>()

    class FakeObserver {
      constructor(cb: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
        capturedCb = cb
      }
      observe(el: Element) {
        observedSet.add(el)
      }
      unobserve(el: Element) {
        observedSet.delete(el)
      }
    }

    const loader = createInView(FakeObserver as any)
    const elements = Array.from({ length: 200 }, () => ({} as Element))
    const callbacks = elements.map(() => vi.fn())
    const cleanups = elements.map((el, i) => loader.watch(el, callbacks[i]))

    expect(observedSet.size).toBe(200)
    callbacks.forEach((cb) => expect(cb).not.toHaveBeenCalled())

    // Fire callback for 6 elements with isIntersecting: true
    const six = elements.slice(0, 6)
    capturedCb!(six.map((target) => ({ target, isIntersecting: true })))

    for (let i = 0; i < 6; i++) {
      expect(callbacks[i]).toHaveBeenCalledTimes(1)
      expect(observedSet.has(elements[i])).toBe(false)
    }
    for (let i = 6; i < 200; i++) {
      expect(callbacks[i]).not.toHaveBeenCalled()
    }

    // Firing again doesn't call them again
    capturedCb!(six.map((target) => ({ target, isIntersecting: true })))
    for (let i = 0; i < 6; i++) {
      expect(callbacks[i]).toHaveBeenCalledTimes(1)
    }

    // isIntersecting: false calls nothing
    capturedCb!([{ target: elements[10], isIntersecting: false }])
    expect(callbacks[10]).not.toHaveBeenCalled()

    // Cleanup cancels watch
    cleanups[20]()
    expect(observedSet.has(elements[20])).toBe(false)
    capturedCb!([{ target: elements[20], isIntersecting: true }])
    expect(callbacks[20]).not.toHaveBeenCalled()

    // createInView(undefined) calls onEnter immediately
    const fallbackCb = vi.fn()
    const fallback = createInView(undefined)
    const unwatch = fallback.watch({} as Element, fallbackCb)
    expect(fallbackCb).toHaveBeenCalledTimes(1)
    unwatch()
  })
})
