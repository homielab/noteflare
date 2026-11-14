/**
 * Syntax highlighting for fenced code blocks, with TanStack Highlight.
 * Only the languages listed here are bundled; anything else renders as plain escaped text.
 * Token colors are the `--th-*` variables in index.css.
 */
import { createHighlighter } from '@tanstack/highlight/core'
import { createTanStackMarkdownHighlighter } from '@tanstack/highlight/markdown'
import { c } from '@tanstack/highlight/languages/c'
import { cpp } from '@tanstack/highlight/languages/cpp'
import { csharp } from '@tanstack/highlight/languages/csharp'
import { css } from '@tanstack/highlight/languages/css'
import { diff } from '@tanstack/highlight/languages/diff'
import { dockerfile } from '@tanstack/highlight/languages/dockerfile'
import { go } from '@tanstack/highlight/languages/go'
import { html } from '@tanstack/highlight/languages/html'
import { ini } from '@tanstack/highlight/languages/ini'
import { java } from '@tanstack/highlight/languages/java'
import { js } from '@tanstack/highlight/languages/js'
import { json } from '@tanstack/highlight/languages/json'
import { jsx } from '@tanstack/highlight/languages/jsx'
import { kotlin } from '@tanstack/highlight/languages/kotlin'
import { markdown } from '@tanstack/highlight/languages/markdown'
import { php } from '@tanstack/highlight/languages/php'
import { python } from '@tanstack/highlight/languages/python'
import { ruby } from '@tanstack/highlight/languages/ruby'
import { rust } from '@tanstack/highlight/languages/rust'
import { shell } from '@tanstack/highlight/languages/shell'
import { sql } from '@tanstack/highlight/languages/sql'
import { swift } from '@tanstack/highlight/languages/swift'
import { toml } from '@tanstack/highlight/languages/toml'
import { ts } from '@tanstack/highlight/languages/ts'
import { tsx } from '@tanstack/highlight/languages/tsx'
import { yaml } from '@tanstack/highlight/languages/yaml'

const highlighter = createHighlighter({
  languages: [
    c, cpp, csharp, css, diff, dockerfile, go, html, ini, java, js, json, jsx, kotlin, markdown,
    php, python, ruby, rust, shell, sql, swift, toml, ts, tsx, yaml,
  ],
})

/** Returns escaped token markup for the inside of a `<pre><code>` block. */
export const highlightCode = createTanStackMarkdownHighlighter(highlighter)
