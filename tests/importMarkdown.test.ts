import { describe, expect, it } from 'vitest'
import { dedupeKey, isMarkdownPath, parseMarkdown } from '../src/lib/importMarkdown'

describe('parseMarkdown', () => {
  it('uses frontmatter title, tags (list and inline), pinned; strips frontmatter', () => {
    const src = '﻿---\r\ntitle: "Kế hoạch Q4"\r\ntags:\r\n  - work\r\n  - "#urgent"\r\npinned: true\r\nauthor: x\r\n---\r\n\r\nNội dung\r\n'
    const n = parseMarkdown('Vault/Work/plan.md', src)
    expect(n.title).toBe('Kế hoạch Q4')
    expect(n.body).toBe('Nội dung')
    expect(n.labels).toEqual(['work', 'urgent', 'Work'])
    expect(n.pinned).toBe(true)
    expect(n.archived).toBe(false)
  })

  it('takes the first H1 as title and removes it from the body', () => {
    const n = parseMarkdown('notes/a.md', '# Đi chợ\n\n- [ ] Rau\n', 1)
    expect(n.title).toBe('Đi chợ')
    expect(n.body).toBe('- [ ] Rau')
    expect(n.labels).toEqual([])
    expect(n.modifiedAt).toBe(1)
  })

  it('falls back to the file name and keeps nested folders as one label', () => {
    const n = parseMarkdown('Root/Projects/2026/ý tưởng.markdown', 'Chỉ có nội dung', 0)
    expect(n.title).toBe('ý tưởng')
    expect(n.labels).toEqual(['Projects/2026'])
  })

  it('reads a known color and ignores unknown ones', () => {
    expect(parseMarkdown('x.md', '---\ncolor: sage\n---\nz').color).toBe('sage')
    expect(parseMarkdown('x.md', '---\ncolor: neon\n---\nz').color).toBe('default')
  })

  it('handles inline tag arrays and comma strings', () => {
    expect(parseMarkdown('x.md', '---\ntags: [a, "b c"]\n---\nz').labels).toEqual(['a', 'b c'])
    expect(parseMarkdown('x.md', '---\ntags: a, b\n---\nz').labels).toEqual(['a', 'b'])
  })

  it('does not treat a horizontal rule mid-file as frontmatter', () => {
    const n = parseMarkdown('x.md', 'Đầu\n\n---\n\nCuối')
    expect(n.body).toBe('Đầu\n\n---\n\nCuối')
  })
})

describe('isMarkdownPath', () => {
  it('accepts markdown, skips tool folders and other files', () => {
    expect(isMarkdownPath('Vault/a.md')).toBe(true)
    expect(isMarkdownPath('Vault/a.MARKDOWN')).toBe(true)
    expect(isMarkdownPath('Vault/.obsidian/workspace.md')).toBe(false)
    expect(isMarkdownPath('repo/node_modules/x/README.md')).toBe(false)
    expect(isMarkdownPath('__MACOSX/._a.md')).toBe(false)
    expect(isMarkdownPath('Vault/img.png')).toBe(false)
  })
})

it('dedupeKey ignores surrounding whitespace', () => {
  expect(dedupeKey({ title: ' A ', body: 'b\n' })).toBe(dedupeKey({ title: 'A', body: 'b' }))
  it('shortens a long folder label to whole folder names', () => {
    const n = parseMarkdown('Vault/workshops/VibecodeKit/VibecodeKit/skills/general-purpose/a.md', 'x')
    expect(n.labels).toEqual(['VibecodeKit/skills/general-purpose'])
    const deep = parseMarkdown(`Vault/${'x'.repeat(60)}/a.md`, 'x')
    expect(deep.labels).toEqual(['x'.repeat(40)])
  })
})
