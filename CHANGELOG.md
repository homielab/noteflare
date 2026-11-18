# Changelog

All notable changes to NoteFlare are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/). Before 1.0, a minor version may contain breaking changes; they are listed under **Breaking**.

## [Unreleased]

## [0.8.0] - 2026-11-18

### Added

- Google Keep import now brings your images: drop the Keep folder or the Takeout .zip with image storage turned on. Without it, notes import as before and you're told how many images were skipped.
- Images: a gallery of every image in your notes, with a Files tab for other attachments. Search it or filter by label, then jump straight to the note.
- Rename or delete a label everywhere at once: open the label, then **Edit label**. Renaming to a label that exists merges the two.
- Make a copy of a note from its menu.
- Images you've already seen now show offline, and aren't downloaded again each time you open the app.

### Changed

- Images now say what's wrong: offline, deleted, storage turned off or can't be decrypted — with Retry when the connection hiccups, and no more jumping text while they load.
- Uploads show a preview with progress and a Cancel button.

### Fixed

- Boards with hundreds of notes are quick again: opening a note, typing in it and closing it no longer lag.
- First-run login setup no longer fails with “Check your connection” when the database migrations weren't applied. It now says so and tells you how to fix it: run `bun run db:migrate:remote`, or deploy again.

## [0.7.0] - 2026-11-17

### Added

- Label several notes at once: tap Select, pick your notes, then add or remove a label for all of them. One Undo puts everything back.

## [0.6.0] - 2026-11-17

### Changed

- Imported notes keep their original dates from Standard Notes, Evernote, Simplenote, Google Keep or Markdown files. A note shows when it was last edited there until you edit it here, and exports keep those dates.

### Fixed

- Importing a Standard Notes backup works with the .zip file Standard Notes downloads. Before, the file couldn't be picked and a dropped zip was ignored. Other exports packed as a .zip, such as Simplenote's, now import too.

## [0.5.0] - 2026-11-16

### Added

- Attach any file to a note, not only images: a PDF, a spreadsheet, a zip. It is encrypted on your device like everything else and shows as a chip with its name and size; click it to download the file. Needs the optional attachment storage, up to 10 MB per file.
- Select several notes, or everything in the current view, and move them to the trash in one go. They stay in the trash for 30 days, so you can restore them.

### Changed

- Security improvements to exporting notes.

## [0.4.0] - 2026-11-16

### Added

- Update NoteFlare from the app: after a one-time setup, **Update now** in About and updates installs the new version for you.
- Scripts and apps using an API token can make up to 60 requests a minute; past that they are asked to wait a minute.
- Share a note with anyone by link: they read it without signing in, and the server can't. Links can expire, and you can revoke them.
- Unlock with Face ID, Touch ID, Windows Hello or a security key: add a passkey from the Account menu; your passphrase keeps working.
- Import your notes from Evernote, Simplenote and Standard Notes: drop the export file and every note arrives encrypted.
- NoteFlare now speaks Spanish, French, German and Brazilian Portuguese, and picks your browser's language the first time.
- Changes appear on your other open devices right away, without waiting or reloading.
- With image storage turned on, NoteFlare saves an encrypted backup every day and keeps the last 14; restore one from Export and backup.
- Deploy with an AI coding agent: paste the prompt from the README into Claude Code, Codex or a similar tool.
- Let Claude, Cursor and other AI tools read and write your notes through the CLI's MCP server; notes are decrypted on your computer.

## [0.3.0] - 2026-11-15

### Added

- A new deployment now sets up its own Cloudflare login: paste a Cloudflare API token on the first screen instead of configuring Zero Trust and editing files.

## [0.2.0] - 2026-11-15

### Changed

- Signing out now clears everything NoteFlare kept on this device, and signs out your other open tabs too.
- Auto-lock also counts the time your device was asleep, so your notes are locked when you come back.

### Fixed

- Opening a note dims the whole page again, header included, and the note grows smoothly into the editor.
- Pressing Unlock with an empty passphrase now asks for it instead of blaming the server.

## [0.1.0] - 2026-11-14

First public release.

### Notes

- Google Keep–style board: pin, archive, trash (purged after 30 days, or emptied with one button), eight colors, labels and search.
- Reorder notes by dragging a card onto another, or with Alt+arrow keys on a focused card. Dropping onto a pinned note pins.
- Archive and Trash stay in reach beside the label filters, however many labels there are.
- Markdown notes rendered with TanStack Markdown, with checklists you can tick from the card and syntax highlighting for 26 common languages in code blocks.
- English and Vietnamese interface.
- Decrypt-in-place unlock, View Transitions and motion that respects reduced-motion settings.
- Markdown editor helpers: Enter continues lists and checklists, Tab indents, a checklist button and Ctrl/⌘+Shift+L.
- Grid or list layout, keyboard shortcut sheet (`?`), and a smooth, reduced-motion-aware animation system.
- Installable app polish: share text and links to NoteFlare (Android), open `.md` files with it (desktop), screenshots in the install dialog, Add to Home Screen steps on iPhone and iPad, and relaunching reuses the open window.
- Faster start: the notes view and Argon2id load after the lock screen appears (first download 567 KB → 343 KB).
- Updates wait for you to tap Reload instead of switching versions underneath an open page.
- Built for phones: no zoom when a field gets focus, layouts that stay above the on-screen keyboard (iOS and Android), Done at the top of the editor, and touch targets of at least 40px.

### Import, export and images

- Drag a folder or `.md` files anywhere to import; duplicates are skipped. An Obsidian vault works.
- Import from Google Keep: drop the Keep folder of a Google Takeout export. Text, checklists, labels, colors, pinned and archived are kept.
- Export and backup in the account menu: download your notes as Markdown (.zip), download an encrypted backup, and restore one.
- Encrypted images (optional): attach, paste or drop images into a note. They are encrypted on your device and stored in an R2 bucket. Off unless you add the `ATTACHMENTS` R2 binding in `wrangler.jsonc`.

### Updates

- **About and updates** shows this deployment's version, checks GitHub for a newer release through the Worker (cached, no tracking, `UPDATE_CHECK_REPO` to change or turn off) and shows the bundled changelog.
- A **What's new** prompt after each update.
- One-click update for copies made by the Deploy button: add `.github/workflows/update.yml` to your copy once, then use **Run workflow**. Your `wrangler.jsonc` settings are kept.
- `bun run release` cuts a version from this changelog; tagging it publishes a GitHub release with the same notes.

### Security

- End-to-end encryption: Argon2id passphrase key, AES-256-GCM per note bound to the note id.
- Recovery code generated at setup; change the passphrase without re-encrypting notes.
- Clients refuse unsafe key-derivation settings sent by a server.
- Sign-in through Cloudflare Access, with the JWT verified inside the Worker. A deployment with no Access in front of it says so and links to the setup guide.
- The lock screen shows your email masked, e.g. `m••••••h@example.com`.
- Strict Content Security Policy, HSTS, `X-Frame-Options` and `Cross-Origin-Opener-Policy`; hardening headers on API responses.
- Optional `ALLOWED_EMAILS` allowlist checked by the Worker on top of Cloudflare Access, for sessions and tokens.
- `DEV_USER_EMAIL` works only on `localhost`, so it can't open a deployed app by mistake.
- Key-derivation settings are bounds-checked by both the server and the client.
- Release notes are shown without images, so the app never contacts third parties.
- Release workflow: only a dependency-free job can publish; Dependabot for Bun and Actions.

### Offline and sync

- Installable PWA that opens, unlocks and edits offline.
- Changes queue on the device and sync when back online.
- The header says when your notes were last synced ("Synced 2 min ago"); clicking it syncs now. The account menu shows the same line, for phones.
- Automatic three-way merge when two devices edit the same note; a conflict copy only when both changed the same lines.

### Integrations

- Public, versioned API at `/api/v1` with an OpenAPI 3.1 description.
- Personal access tokens with read or write scope, expiry and revocation.
- `GET`, `PUT` and `DELETE /api/v1/blobs/{id}` for encrypted attachments, and `uploadAttachment`, `getAttachment`, `deleteAttachment` in the SDK.
- `@noteflare/client` TypeScript SDK that encrypts and decrypts on the client.
- `noteflare` CLI: list, show, add, append, trash, export to Markdown.

### Deploy

- One-click Deploy to Cloudflare button; D1 is created automatically.
- Runs on the Workers and D1 free tiers.

[Unreleased]: https://github.com/homielab/noteflare/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/homielab/noteflare/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/homielab/noteflare/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/homielab/noteflare/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/homielab/noteflare/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/homielab/noteflare/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/homielab/noteflare/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/homielab/noteflare/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/homielab/noteflare/releases/tag/v0.1.0
