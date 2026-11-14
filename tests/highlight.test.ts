import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { highlightCode } from '../src/lib/highlight'
import { NoteMarkdown } from '../src/components/NoteMarkdown'

describe('code highlighting', () => {
  it('marks tokens of a known language, including aliases', () => {
    expect(highlightCode('const a = 1', 'ts')).toContain('th-keyword')
    expect(highlightCode('echo hi', 'bash')).toContain('th-command')
  })
  it('escapes code in an unknown language instead of rendering it', () => {
    expect(highlightCode('<script>alert(1)</script>', 'nope')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
  it('is applied to fenced code blocks in a note', () => {
    const html = renderToStaticMarkup(createElement(NoteMarkdown, { source: '```js\nconst a = "<b>"\n```' }))
    expect(html).toContain('th-keyword')
    expect(html).not.toContain('<b>')
  })
})
