# Sample notes

A small folder of Markdown notes for trying NoteFlare's import.
Drag the `sample-notes` folder onto the NoteFlare window, or use **Account → Import a Markdown folder…**.

What the importer understands:

- YAML frontmatter: `title`, `tags` (list, `[a, b]` or `a, b`), `color` (default, sand, sage, sky, lilac, rose, clay, slate), `pinned`, `archived`
- Otherwise the first `# Heading` becomes the title, or the file name if there is none
- Sub-folders become labels (`Work/…` → `#Work`, `Personal/Recipes/…` → `#Personal/Recipes`)
- Notes that already exist (same title and body) are skipped, so importing twice is safe
