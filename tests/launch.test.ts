import { describe, expect, it } from 'vitest'
import { parseLaunchURL } from '../src/lib/launch'

describe('parseLaunchURL', () => {
  it('reads the New note shortcut', () => {
    expect(parseLaunchURL('/?new')).toEqual({ kind: 'new' })
  })
  it('turns a share into a note, adding the link only once', () => {
    expect(parseLaunchURL('/?share_title=Read%20later&share_text=Good%20post&share_url=https%3A%2F%2Fx.com%2Fa')).toEqual({
      kind: 'share',
      title: 'Read later',
      text: 'Good post\n\nhttps://x.com/a',
    })
    expect(parseLaunchURL('/?share_text=See%20https%3A%2F%2Fx.com%2Fa&share_url=https%3A%2F%2Fx.com%2Fa')).toEqual({
      kind: 'share',
      title: '',
      text: 'See https://x.com/a',
    })
    expect(parseLaunchURL('/?share_url=https%3A%2F%2Fx.com')).toEqual({ kind: 'share', title: '', text: 'https://x.com' })
  })
  it('ignores ordinary visits and empty shares', () => {
    expect(parseLaunchURL('/')).toBeNull()
    expect(parseLaunchURL('/?share_title=%20&share_text=')).toBeNull()
    expect(parseLaunchURL('/?utm_source=x')).toBeNull()
  })
  it('caps very long shared titles', () => {
    const r = parseLaunchURL('/?share_title=' + 'a'.repeat(1000))
    expect(r && r.kind === 'share' && r.title.length).toBe(300)
  })
})
