# Changelog

All notable changes to NoteFlare are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/). Before 1.0, a minor version may contain breaking changes; they are listed under **Breaking**.

## [Unreleased]

### Notes

- **Reorder notes** by dragging a card onto another, or with Alt+arrow keys on a focused card. Dropping onto a pinned note pins.
- **Export and backup** in the account menu: download your notes as Markdown (.zip), download an encrypted backup, and restore one.
- **Import from Google Keep**: drop the Keep folder of a Google Takeout export. Text, checklists, labels, colors, pinned and archived are kept.
- **Encrypted images** (optional): attach, paste or drop images into a note. They are encrypted on your device and stored in an R2 bucket. Off unless you add the `ATTACHMENTS` R2 binding in `wrangler.jsonc`.
- **Code highlighting** in fenced code blocks, for 26 common languages.
- The lock screen shows your email masked, e.g. `m••••••h@example.com`.
- Titles containing quotes now survive an export followed by an import.
- A deployment with no Cloudflare Access in front of it now says so and links to the setup guide, instead of "Your session has expired".

### API

- `GET`, `PUT` and `DELETE /api/v1/blobs/{id}` for encrypted attachments, `attachments` in `/me`, and `uploadAttachment`, `getAttachment`, `deleteAttachment` in the SDK.

## [0.1.0] - 2026-11-17

First public release.

### Notes

- Google Keep–style board: pin, archive, trash (purged after 30 days), eight colors, labels and search.
- Markdown notes rendered with TanStack Markdown, with checklists you can tick from the card.
- Drag a folder or `.md` files anywhere to import; duplicates are skipped.
- English and Vietnamese interface.
- Decrypt-in-place unlock, View Transitions and motion that respects reduced-motion settings.
- Markdown editor helpers: Enter continues lists and checklists, Tab indents, a checklist button and Ctrl/⌘+Shift+L.
- Grid or list layout, keyboard shortcut sheet (`?`), and a smooth, reduced-motion-aware animation system.
- Installable app polish: share text and links to NoteFlare (Android), open `.md` files with it (desktop), screenshots in the install dialog, Add to Home Screen steps on iPhone and iPad, and relaunching reuses the open window.
- Faster start: the notes view and Argon2id load after the lock screen appears (first download 567 KB → 343 KB).
- Updates wait for you to tap Reload instead of switching versions underneath an open page.
- Built for phones: no zoom when a field gets focus, layouts that stay above the on-screen keyboard (iOS and Android), Done at the top of the editor, and touch targets of at least 40px.

### Updates

- **About and updates** shows this deployment's version, checks GitHub for a newer release through the Worker (cached, no tracking, `UPDATE_CHECK_REPO` to change or turn off) and shows the bundled changelog.
- A **What's new** prompt after each update.
- `bun run release` cuts a version from this changelog; tagging it publishes a GitHub release with the same notes.

### Security

- End-to-end encryption: Argon2id passphrase key, AES-256-GCM per note bound to the note id.
- Recovery code generated at setup; change the passphrase without re-encrypting notes.
- Clients refuse unsafe key-derivation settings sent by a server.
- Sign-in through Cloudflare Access, with the JWT verified inside the Worker.
- Strict Content Security Policy, HSTS, `X-Frame-Options` and `Cross-Origin-Opener-Policy`; hardening headers on API responses.
- Optional `ALLOWED_EMAILS` allowlist checked by the Worker on top of Cloudflare Access, for sessions and tokens.
- `DEV_USER_EMAIL` works only on `localhost`, so it can't open a deployed app by mistake.
- Key-derivation settings are bounds-checked by both the server and the client.
- Release notes are shown without images, so the app never contacts third parties.
- Release workflow: only a dependency-free job can publish; Dependabot for Bun and Actions.

### Offline and sync

- Installable PWA that opens, unlocks and edits offline.
- Changes queue on the device and sync when back online.
- Automatic three-way merge when two devices edit the same note; a conflict copy only when both changed the same lines.

### Integrations

- Public, versioned API at `/api/v1` with an OpenAPI 3.1 description.
- Personal access tokens with read or write scope, expiry and revocation.
- `@noteflare/client` TypeScript SDK that encrypts and decrypts on the client.
- `noteflare` CLI: list, show, add, append, trash, export to Markdown.

### Deploy

- One-click Deploy to Cloudflare button; D1 is created automatically.
- Runs on the Workers and D1 free tiers.

[Unreleased]: https://github.com/homielab/noteflare/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/homielab/noteflare/releases/tag/v0.1.0
