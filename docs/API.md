# NoteFlare API and integrations

Build anything that reads or writes NoteFlare notes: a CLI, an editor plugin, a
browser extension, a mobile app, a backup script. This guide covers access
tokens, the HTTP API, the TypeScript SDK and the encryption format, so clients
can be written in any language.

- [How access works](#how-access-works)
- [Quick start](#quick-start) — [SDK](#typescript-sdk) · [CLI](#cli) · [curl](#curl)
- [Set up Cloudflare Access for API clients](#set-up-cloudflare-access-for-api-clients)
- [Endpoints](#endpoints)
- [Syncing](#syncing)
- [Encryption format](#encryption-format) (for clients in other languages)
- [Errors and limits](#errors-and-limits)
- [Security notes](#security-notes)

## How access works

A client needs two separate secrets:

| Secret | What it unlocks | Where it comes from |
|---|---|---|
| **API token** (`nf_…`) | Talking to the API: fetching and storing **encrypted** notes | NoteFlare → *Account → Integrations* |
| **Passphrase** | Reading and writing note content (titles, bodies, labels, colors) | The user; it never leaves the client |

A token on its own exposes nothing readable. The server stores only ciphertext,
and the key that decrypts it is wrapped with the user's passphrase.

### Tokens

Create tokens in the web app under **Account → Integrations**. The token is shown
once; NoteFlare stores only its SHA-256 hash.

| Scope | Can | Can't |
|---|---|---|
| `read` | Read the vault, list and fetch notes | Create, change or delete anything |
| `write` | Everything `read` can, plus create, update, trash, restore and delete notes | — |

No token can manage tokens or change the passphrase; those are web-app only.
Tokens can expire (30 days, 90 days, a year, or never) and can be revoked at any
time. Each account can have up to 25.

Send the token on every request:

```http
Authorization: Bearer nf_3fK9qa…
```

## Quick start

### TypeScript SDK

`@noteflare/client` works in Node 20+, Deno, Bun, browsers and extensions. It
encrypts and decrypts on your side and handles conflicts.

```bash
bun run build:client   # from the repository root; the package lives in packages/client
```

```ts
import { NoteFlareClient, ConflictError } from '@noteflare/client'

const nf = new NoteFlareClient({ url: 'https://notes.example.com', token: process.env.NOTEFLARE_TOKEN! })
await nf.unlock(process.env.NOTEFLARE_PASSPHRASE!) // Argon2id: takes about a second

const notes = await nf.list()                       // decrypted, pinned first
const note = await nf.create({ title: 'Groceries', body: '- [ ] milk', labels: ['home'] })
await nf.append(note.id, '- [ ] eggs')              // safe even if another device edits at the same time
await nf.update(note.id, (n) => ({ body: n.body.replace('- [ ] milk', '- [x] milk') }))

// Editor-style clients: save a whole note, merged with changes made elsewhere
try {
  await nf.save({ ...note, title: 'Groceries for Saturday' })
} catch (err) {
  if (err instanceof ConflictError) console.log('Both edited the same lines:', err.mine, err.theirs)
}
```

| Method | Does |
|---|---|
| `me()` | Account email, and whether the token can write |
| `unlock(passphrase)` / `unlockWithRecoveryCode(code)` / `lock()` | Derive or forget the key |
| `list({ archived?, trashed?, label? })` | All notes, decrypted |
| `get(id)` | One note |
| `create(input)` | New note |
| `update(id, patch \| note => patch)` | Change fields; re-applied to the latest copy if someone else saved first |
| `append(id, text)` | Add lines to the end of the body |
| `save(note)` | Write a whole edited note; three-way merges with other devices' changes, or throws `ConflictError` |
| `archive(id, archived?)`, `trash(id)`, `restore(id)`, `deleteForever(id)` | Move notes around |
| `changes(cursor)` / `ids()` | Incremental sync (see [Syncing](#syncing)) |

### CLI

A small CLI built on the SDK lives in `packages/cli`:

```bash
export NOTEFLARE_URL=https://notes.example.com
export NOTEFLARE_TOKEN=nf_…            # a write token
node packages/cli/bin/noteflare.mjs ls
node packages/cli/bin/noteflare.mjs add "Trip to Đà Lạt" "- [ ] Book flights" --label travel --pin
echo "- [ ] Pack a jacket" | node packages/cli/bin/noteflare.mjs append trip
node packages/cli/bin/noteflare.mjs export ./backup    # Markdown with frontmatter; re-importable
```

It asks for the passphrase, or reads `NOTEFLARE_PASSPHRASE`. `noteflare help` lists every command.

### MCP server (AI tools)

`noteflare mcp` runs a local [MCP](https://modelcontextprotocol.io) server on stdin/stdout, so Claude, Cursor and other AI tools can read and write your notes. Notes are decrypted on your computer; the NoteFlare server still sees only ciphertext. Set up the CLI as above (including `bun run build:client`), and set `NOTEFLARE_PASSPHRASE`: the server can't prompt, because stdin carries the protocol.

Tools:

- `search_notes`: find notes by text or label; returns titles and snippets.
- `get_note`: read one note in full.
- `create_note`: create a note.
- `append_to_note`: add text to the end of a note.
- `update_note`: change title, body, labels, pinned or archived.
- `trash_note`: move a note to the trash.

With a read-only token only `search_notes` and `get_note` exist. Use a read-only token unless the AI needs to write.

> Once a tool reads a note, its text goes to the AI provider in plaintext. Note content is untrusted input to the AI: a note that says "ignore your instructions" must not be obeyed.

Claude Code:

```bash
claude mcp add noteflare \
  --env NOTEFLARE_URL=https://notes.example.com \
  --env NOTEFLARE_TOKEN=nf_… \
  --env NOTEFLARE_PASSPHRASE=… \
  -- node /path/to/noteflare/packages/cli/bin/noteflare.mjs mcp
```

Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "noteflare": {
      "command": "node",
      "args": ["/path/to/noteflare/packages/cli/bin/noteflare.mjs", "mcp"],
      "env": {
        "NOTEFLARE_URL": "https://notes.example.com",
        "NOTEFLARE_TOKEN": "nf_…",
        "NOTEFLARE_PASSPHRASE": "…"
      }
    }
  }
}
```

### curl

```bash
curl -H "Authorization: Bearer $NOTEFLARE_TOKEN" https://notes.example.com/api/v1/me
# {"email":"you@example.com","hasVault":true,"auth":"token","scope":"write"}
```

Anything beyond `/me` returns ciphertext; use the SDK or the [encryption format](#encryption-format) to read it.

The full machine-readable description is served at **`/api/v1/openapi.json`** (OpenAPI 3.1, no token needed).

## Set up Cloudflare Access for API clients

Cloudflare Access protects the whole NoteFlare domain with a browser login,
which a CLI or an app can't complete. Pick one of these for the `/api/v1` path.

**Option A — Bypass (simplest).** Every `/api/v1` request must still carry a
NoteFlare token; the Worker rejects anything else.

1. In **Zero Trust → Access → Applications**, add a **Self-hosted** application.
2. Domain: your NoteFlare domain, **Path: `api/v1`**.
3. Policy: action **Bypass**, include **Everyone**.

**Option B — Service Auth (defence in depth).** Requests need a Cloudflare
Access service token *and* a NoteFlare token.

1. **Zero Trust → Access → Service Auth → Create service token**. Copy the Client ID and Secret.
2. Add a **Self-hosted** application for **Path: `api/v1`** with a policy whose action is **Service Auth** and which includes that service token.
3. Send both on every request: `CF-Access-Client-Id` and `CF-Access-Client-Secret`. The SDK takes them as `headers`; the CLI reads `NOTEFLARE_ACCESS_CLIENT_ID` and `NOTEFLARE_ACCESS_CLIENT_SECRET`.

Browser-based clients on another origin (CORS) work with option A. With option B,
enable CORS in the Access application's settings as well.

If a client gets `access_redirect`, Access is still sending `/api/v1` to the login page.

## Endpoints

Base URL: `https://<your-domain>/api/v1`. JSON in and out; `POST` bodies must be
sent as `Content-Type: application/json`. CORS is open to any origin (tokens are
never sent automatically by browsers, so this is safe).

| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/health` | none | `{ "ok": true, "api": "v1", "version": "0.1.0" }` |
| GET | `/openapi.json` | none | OpenAPI 3.1 description |
| GET | `/me` | read | `{ email, hasVault, auth, scope, attachments }` |
| GET | `/version` | read | `{ version, checkEnabled, latest, updateAvailable, checkedAt }`: this server's version and the newest release (`?refresh=1` skips the 6-hour cache) `canUpdate` is always `false` for tokens: only the web app can start an update |
| GET | `/vault` | read | KDF parameters and wrapped data key (needed to unlock) |
| GET | `/notes?since=<ms>` | read | Notes with `updatedAt > since`, oldest first; `since=0` returns all |
| GET | `/notes/index` | read | `[{ id, version }]` for every note |
| GET | `/notes/{id}` | read | One note |
| PUT | `/notes/{id}` | write | Create (`baseVersion: 0`) or update (`baseVersion: <current>`) |
| POST | `/notes/batch` | write | Create up to 40 notes in one transaction: `{ "notes": [{ id, …NoteWrite }] }` |
| DELETE | `/notes/{id}` | write | Delete forever; the note must already be in the trash |
| GET | `/blobs/{id}` | read | An encrypted attachment (binary) |
| PUT | `/blobs/{id}` | write | Store an encrypted attachment: raw bytes, `Content-Type: application/octet-stream`, at most 10 MB before encryption |
| DELETE | `/blobs/{id}` | write | Delete an attachment |
| GET | `/backups` | read | `{ "backups": [{ "date": "2026-11-16", "size": 12345 }] }`, newest first; empty without the R2 binding |
| GET | `/backups/{date}` | read | One daily backup (`YYYY-MM-DD`): the encrypted JSON file the app exports. `501` without the R2 binding |

Shared links are managed by the web app only (`/api/shares`, Access session; tokens get `403`). Their public side, `GET /api/share/{id}`, needs no auth and returns only `{ ciphertext, iv, expiresAt }`, or `404` when the link is revoked, expired or its note is in the trash.

A note as stored on the server:

```json
{
  "id": "f9bf0c79-…",
  "ciphertext": "base64…",
  "iv": "base64 (12 bytes)",
  "pinned": false,
  "archived": false,
  "trashedAt": null,
  "position": 1793604886470,
  "version": 3,
  "createdAt": 1793604886481,
  "updatedAt": 1793604886601
}
```

To write, send the same fields except `id`, `version`, `createdAt` and
`updatedAt`, plus `baseVersion`. Generate the id yourself (UUID v4).

## Attachments

Deployments with an R2 bucket bound as `ATTACHMENTS` can store encrypted images and files; `/me` reports this as `attachments: true`, and the blob routes answer `501 attachments_disabled` otherwise.

A note refers to an image as ordinary Markdown, `![alt](/api/blobs/<id>)`. The link may end with `#w=<width>&h=<height>` (pixels): the app writes it for new uploads so the box is reserved before the image loads. It never reaches the server, is optional, and readers ignore keys they don't know; the SDK's `uploadAttachment` leaves it out. The app may also add `&t=<id>`: the id of the image's thumbnail, a second blob in the same format holding a small version (longest side 400 px). A client that deletes an image's blob should delete the blob `t` names too; one that ignores `t` loses nothing. The blob is `iv (12 bytes) || AES-256-GCM ciphertext` under the data key with AAD `blob:<id>`. The plaintext is one byte with the length of the MIME type, the MIME type, then the image bytes, so the server never learns the file type. Clients show `image/png`, `image/jpeg`, `image/gif`, `image/webp` and `image/avif` only.

Any other file is a link, `[report.pdf (1.2 MB)](/api/blobs/<id>)`, which the app shows as a chip that downloads it. Same encryption; the plaintext is a zero byte, the length of a header (2 bytes, big endian), the header as UTF-8 JSON `{"name": "report.pdf", "type": "application/pdf"}`, then the file bytes, so the name and type stay hidden too. An image plaintext never starts with a zero byte. Treat the name and type as untrusted: save the file, do not render it.

```ts
const { markdown } = await nf.uploadAttachment(bytes, 'image/png', 'diagram')
await nf.create({ title: 'With a picture', body: markdown })
const { bytes: image, type } = await nf.getAttachment(id)

const pdf = await nf.uploadFile(pdfBytes, 'report.pdf', 'application/pdf')
const { bytes, file } = await nf.getAttachment(pdf.id) // file = { name, type }
```

With the same bucket, the daily cron saves each user's encrypted backup under `backups/<email>/<date>.json` and keeps the newest 14. They are ciphertext, like `GET /notes`.

The server does not track which note uses which blob. Delete a blob yourself when you delete the last note that refers to it.

## Syncing

- **Cursor.** Remember the largest `updatedAt` you've received and ask for
  `GET /notes?since=<cursor>`. Re-reading a second or two before the cursor is
  harmless (compare `version`) and guards against equal timestamps.
- **Deletions.** Notes deleted forever (by a user, or by the 30-day trash
  cleanup) simply stop existing. Call `GET /notes/index` now and then and drop
  local notes whose id is missing.
- **Conflicts.** Every write names the version it's based on. If the note has
  changed since, the server answers **409** with `{ "error": "conflict", "current": <note> }`.
  Either re-apply your change on `current` (what `update()` does), or three-way
  merge your edit with `current` using the version you started from (what
  `save()` does: lines changed on only one side are combined, labels are merged
  as sets). Don't silently overwrite.
- **Deleted while you edited.** A `PUT` with `baseVersion > 0` returns **404** if
  the note no longer exists. Re-create it with `baseVersion: 0` if the user's
  edit should win.

## Encryption format

Everything here happens on the client. Implementations must match it exactly to
interoperate. It has been verified with an independent Python client (below).

**Unlocking**

1. `GET /vault` → `{ kdf: { name, salt, memoryKiB, iterations, parallelism }, wrappedDek, recoveryDek, version }`.
2. Refuse weak parameters: `name` must be `argon2id`, `memoryKiB ≥ 19456`,
   `iterations ≥ 2`, salt ≥ 16 bytes. This stops a hostile server from making
   passphrases cheap to guess.
3. `KEK = Argon2id(password = UTF-8(NFKC(passphrase)), salt, t = iterations, m = memoryKiB, p = parallelism, length = 32, version 0x13)`.
4. `wrappedDek` is base64 of `iv (12 bytes) || ciphertext+tag`.
   `DEK = AES-256-GCM-decrypt(key = KEK, iv, data, AAD = "noteflare:dek:v1")` → 32 bytes.
   A failed tag check means a wrong passphrase.

With the **recovery code** instead: uppercase it, remove everything but `0-9A-Z`,
map `O→0` and `I`, `L→1`, then
`RKEK = HKDF-SHA256(ikm = ASCII(code), salt = "noteflare:recovery:v1", info = "", length = 32)`
and unwrap `recoveryDek` the same way.

**Notes**

- Plaintext: UTF-8 JSON `{"title": string, "body": string, "color": string, "labels": string[]}`.
  `body` is Markdown. `color` is one of `default, sand, sage, sky, lilac, rose, clay, slate`.
  Optional `importedCreatedAt` / `importedUpdatedAt` (ms since epoch): the dates a note had in the app it was imported from.
  Show them instead of the row's `createdAt` / `updatedAt` when present (the SDK's `noteDates(note)` does this), and drop
  `importedUpdatedAt` when you change the note's content. Readers that don't know them can ignore them. Never use them as a sync cursor.
- `ciphertext = AES-256-GCM(key = DEK, iv = 12 random bytes, AAD = "note:" + id)`, base64, with the tag appended.
- Use a **new random IV for every write**. Never reuse one.
- The AAD binds the ciphertext to the note id, so content can't be moved between notes.
- `pinned`, `archived`, `trashedAt`, `position` are plaintext so the server can sort.

**Python example** (`pip install argon2-cffi cryptography`)

```python
import base64, json, os, unicodedata
from argon2.low_level import hash_secret_raw, Type
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def unlock(vault, passphrase):
    kdf = vault["kdf"]
    assert kdf["name"] == "argon2id" and kdf["memoryKiB"] >= 19456 and kdf["iterations"] >= 2
    kek = hash_secret_raw(unicodedata.normalize("NFKC", passphrase).encode(), base64.b64decode(kdf["salt"]),
                          time_cost=kdf["iterations"], memory_cost=kdf["memoryKiB"],
                          parallelism=kdf["parallelism"], hash_len=32, type=Type.ID)
    blob = base64.b64decode(vault["wrappedDek"])
    return AESGCM(kek).decrypt(blob[:12], blob[12:], b"noteflare:dek:v1")  # the DEK

def decrypt(dek, note):
    data = AESGCM(dek).decrypt(base64.b64decode(note["iv"]), base64.b64decode(note["ciphertext"]),
                               f"note:{note['id']}".encode())
    return json.loads(data)

def encrypt(dek, note_id, payload):
    iv = os.urandom(12)
    ct = AESGCM(dek).encrypt(iv, json.dumps(payload, ensure_ascii=False).encode(), f"note:{note_id}".encode())
    return base64.b64encode(ct).decode(), base64.b64encode(iv).decode()
```

## Errors and limits

Errors look like `{ "error": "code", "message": "…" }`.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `bad_request` | Invalid id or body |
| 401 | `unauthorized` / `invalid_token` | Missing, unknown, revoked or expired token |
| 403 | `forbidden` | Read-only token tried to write, or the action is web-app only |
| 404 | `not_found` | No such note (or `DELETE` on a note that isn't in the trash) |
| 409 | `conflict` | The note changed since `baseVersion`; `current` holds the server copy |
| 413 | `too_large` | Batch request over 8 MB |
| 415 | `unsupported_media_type` | `POST` without `Content-Type: application/json` |
| 429 | `rate_limited` | Too many requests from your IP address; wait for the `Retry-After` seconds |

| Limit | Value |
|---|---|
| Ciphertext per note | 512 KB of base64 (about 380 KB of text) |
| Notes per batch | 40, up to 8 MB |
| Requests with a token | 60 a minute per IP address (`TOKEN_LIMITER` in `wrangler.jsonc`; without it, no limit) |
| Tokens per account | 25 |

## Security notes

- A **read** token lets its holder download ciphertext and the wrapped key, and try
  to guess the passphrase offline. Argon2id makes each guess slow, but a long
  passphrase is what really protects you. Give tools the narrowest scope they need.
- A **write** token can't read notes either, but it can trash, overwrite or delete
  them. Keep write tokens for tools you trust, set an expiry, and revoke tokens you
  no longer use (the list shows when each was last used).
- Tokens are 256-bit random strings; only their SHA-256 hash is stored.
- `/api/v1` never accepts the browser's Access cookie, only tokens, so opening it
  to any origin doesn't expose the web session to cross-site requests.
