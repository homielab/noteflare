import { describe, expect, it } from 'vitest'
import { maskEmail } from '../src/lib/maskEmail'

describe('maskEmail', () => {
  it('keeps the first and last character of the name and the whole domain', () => {
    expect(maskEmail('minh@example.com')).toBe('m••h@example.com')
  })
  it('never shows a short name in full', () => {
    expect(maskEmail('ab@example.com')).toBe('a•@example.com')
    expect(maskEmail('a@example.com')).toBe('a•@example.com')
  })
  it('caps the mask so long names do not reveal their length', () => {
    expect(maskEmail('a.very.long.mailbox.name@example.com')).toBe('a••••••••e@example.com')
  })
  it('returns anything that is not an email unchanged', () => {
    expect(maskEmail('')).toBe('')
    expect(maskEmail('not-an-email')).toBe('not-an-email')
  })
})
