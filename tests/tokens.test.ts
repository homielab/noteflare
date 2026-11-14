import { describe, expect, it } from 'vitest'
import { generateToken, hashToken, tokenPrefix } from '../worker/tokens'

describe('API tokens', () => {
  it('are nf_-prefixed, URL-safe, 256-bit and unique', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).toMatch(/^nf_[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  it('are stored as a SHA-256 hex digest and shown by a short prefix', async () => {
    const t = generateToken()
    expect(await hashToken(t)).toMatch(/^[0-9a-f]{64}$/)
    expect(await hashToken(t)).toBe(await hashToken(t))
    expect(tokenPrefix(t)).toBe(t.slice(0, 9))
  })
})
