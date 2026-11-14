import { describe, expect, it } from 'vitest'
import { toggleTask } from '../src/lib/noteModel'

describe('toggleTask', () => {
  it('toggles the nth task and skips fenced code', () => {
    const src = '- [ ] a\n```\n- [ ] not a task\n```\n* [x] b\n1. [ ] c'
    expect(toggleTask(src, 0)).toBe(src.replace('- [ ] a', '- [x] a'))
    expect(toggleTask(src, 1)).toBe(src.replace('* [x] b', '* [ ] b'))
    expect(toggleTask(src, 2)).toBe(src.replace('1. [ ] c', '1. [x] c'))
    expect(toggleTask(src, 9)).toBe(src)
  })
})
