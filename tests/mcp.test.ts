import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module
import { createServer, createTools, serveStdio } from '../packages/cli/lib/mcp.mjs'

const note = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  title: 'Trip',
  body: 'Book flights to Da Lat',
  labels: ['travel'],
  color: 'default',
  pinned: false,
  archived: false,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  ...over,
})

function setup(canWrite = true) {
  const nf = {
    list: vi.fn(async () => [note(), note({ id: 'n2', title: 'Groceries', body: 'milk', labels: [] })]),
    get: vi.fn(async () => note()),
    create: vi.fn(async (i) => note(i)),
    append: vi.fn(async () => note()),
    update: vi.fn(async () => note()),
    trash: vi.fn(async () => note()),
  }
  const server = createServer(createTools(nf, { canWrite }), { name: 'noteflare', version: '0' })
  const call = async (name: string, args: unknown = {}) =>
    server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  return { nf, server, call }
}

const text = (r: any) => r.result.content[0].text as string

describe('mcp server', () => {
  it('lists only read tools without write access', async () => {
    const { server } = setup(false)
    const r = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(r.result.tools.map((t: any) => t.name)).toEqual(['search_notes', 'get_note'])
  })

  it('lists all tools with write access', async () => {
    const { server } = setup(true)
    const r = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(r.result.tools.map((t: any) => t.name)).toEqual([
      'search_notes',
      'get_note',
      'create_note',
      'append_to_note',
      'update_note',
      'trash_note',
    ])
  })

  it('search filters by query and passes label and archived', async () => {
    const { nf, call } = setup()
    const r = await call('search_notes', { query: 'FLIGHTS', label: 'travel', archived: true })
    expect(nf.list).toHaveBeenCalledWith({ archived: true, label: 'travel' })
    const hits = JSON.parse(text(r))
    expect(hits.map((h: any) => h.id)).toEqual(['n1'])
    expect(hits[0].snippet).toContain('flights')
  })

  it('get_note returns the body and reminder when set', async () => {
    const { nf, call } = setup()
    const rem = 1_700_000_000_000
    nf.get.mockResolvedValueOnce(note({ reminder: rem }))
    const res = JSON.parse(text(await call('get_note', { id: 'n1' })))
    expect(res.body).toBe('Book flights to Da Lat')
    expect(res.reminder).toBe(new Date(rem).toISOString())
  })

  it('create_note passes the given fields and parses reminder', async () => {
    const { nf, call } = setup()
    const iso = '2026-11-20T09:00:00.000Z'
    await call('create_note', { title: 'New', body: 'x', labels: ['a'], reminder: iso })
    expect(nf.create).toHaveBeenCalledWith({ title: 'New', body: 'x', labels: ['a'], reminder: Date.parse(iso) })

    const bad = await call('create_note', { title: 'New', reminder: 'not-a-date' })
    expect(bad.result.isError).toBe(true)
    expect(text(bad)).toContain('Invalid reminder date')
  })

  it('update_note passes only the given fields, handles reminder and clear', async () => {
    const { nf, call } = setup()
    await call('update_note', { id: 'n1', pinned: true })
    expect(nf.update).toHaveBeenCalledWith('n1', { pinned: true })

    const iso = '2026-11-20T09:00:00.000Z'
    await call('update_note', { id: 'n1', reminder: iso })
    expect(nf.update).toHaveBeenCalledWith('n1', { reminder: Date.parse(iso) })

    await call('update_note', { id: 'n1', reminder: null })
    expect(nf.update).toHaveBeenCalledWith('n1', { reminder: null })

    const bad = await call('update_note', { id: 'n1', reminder: 'invalid' })
    expect(bad.result.isError).toBe(true)

    const r = await call('update_note', { id: 'n1' })
    expect(r.result.isError).toBe(true)
    expect(text(r)).toBe('Nothing to change')
  })

  it('maps a 403 to the read-only message', async () => {
    const { nf, call } = setup()
    nf.trash.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    const r = await call('trash_note', { id: 'n1' })
    expect(r.result.isError).toBe(true)
    expect(text(r)).toContain('read-only')
  })

  it('rejects an unknown tool, ignores notifications, echoes the protocol version', async () => {
    const { server, call } = setup()
    expect((await call('nope')).error.code).toBe(-32602)
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    const r = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    expect(r.result.protocolVersion).toBe('2024-11-05')
    expect((await server.handle({ jsonrpc: '2.0', id: 2, method: 'x' })).error.code).toBe(-32601)
  })

  it('serves newline-delimited JSON over streams', async () => {
    const { server } = setup()
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (c) => chunks.push(String(c)))
    const done = serveStdio(server, { input, output })
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n\nnot json\n')
    input.end()
    await done
    const lines = chunks.join('').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines.find((l) => l.id === 1).result).toEqual({})
    expect(lines.find((l) => l.id === null).error.code).toBe(-32700)
  })
})
