# Security

NoteFlare's whole promise is that the server can't read your notes. If you find a way it can, or any other vulnerability, we want to hear about it.

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through GitHub:
[Security → Report a vulnerability](https://github.com/homielab/noteflare/security/advisories/new).

Include what you found, how to reproduce it and the impact you expect. We aim to:

| Step | Target |
| --- | --- |
| Acknowledge your report | 3 days |
| Confirm or decline it, with reasoning | 10 days |
| Ship a fix for a confirmed issue | 30 days, sooner for anything that exposes note content |

We credit reporters in the advisory and the changelog unless you'd rather stay anonymous. There is no bug bounty.

## Supported versions

NoteFlare is pre-1.0. Only the latest release on `main` gets security fixes, so keep your deployment up to date (re-run `bun run deploy` after pulling).

## Threat model

### What we protect against

- **The server operator and Cloudflare reading your notes.** Everything about a note's content is encrypted in the browser before upload.
- **A compromised or malicious Worker trying to weaken your key.** Clients refuse key-derivation settings outside safe bounds (Argon2id memory 19–256 MiB, iterations 2–16, parallelism 1–4, salt ≥ 16 bytes). The Worker enforces the same bounds when a vault is saved.
- **Swapping or replaying ciphertext between notes.** Each note is encrypted with its id as additional authenticated data, so moved ciphertext fails to decrypt.
- **Leaked API tokens, with a strong passphrase.** A token only ever yields ciphertext and the wrapped key; reading notes needs the passphrase too. See the caveat below.
- **Forged identity headers and Access misconfiguration.** The Worker verifies the Cloudflare Access JWT's signature, issuer and audience itself, so a Bypass policy or a missing Access app never opens `/api`. The optional `ALLOWED_EMAILS` list is checked on top of the Access policy, for sessions and tokens alike.
- **A local-development setting left on in production.** `DEV_USER_EMAIL` only works for requests to `localhost`; anywhere else the app stays locked.
- **Cross-site requests.** Writes need `Content-Type: application/json` (so browsers preflight them), `/api` sends no CORS headers, and `/api/v1` ignores cookies.
- **Third-party requests from the app.** Notes and the vault never leave your deployment. The CSP limits connections to your own origin, and release notes are shown without images, so viewing them doesn't contact another server.

### What we don't protect against

- **A compromised device or browser.** Malware, a malicious extension or someone with your unlocked laptop can read what you can read.
- **A malicious build of the front end.** If whoever controls your deployment ships modified JavaScript, it can capture your passphrase. You run your own deployment, so this is you, but review changes you pull.
- **Weak passphrases.** Argon2id slows guessing; it doesn't make "password1" safe.
- **Metadata analysis.** See the table below.
- **Losing both your passphrase and recovery code.** There is no backdoor, so there is no recovery.
- **Offline guessing after a leak.** Anyone who gets the wrapped key and salt can try passphrases offline at Argon2id speed. That includes a leaked token (read or write), a copy of the database, or the offline copy on a lost device. A long passphrase makes this impractical; a short one doesn't. Treat tokens like a copy of your encrypted database.
- **A malicious server rolling notes back or hiding them.** Encryption stops the server reading or forging content. It can still serve an older version of a note, withhold or delete notes, or change the unencrypted flags (pinned, archived, trashed), which could send a note to the trash to be purged. Keep exports (`noteflare export`) of anything you can't lose.
- **Remote images in your own notes.** `![](https://…)` in a note loads that image when the note is shown, which tells the image's host your IP address. Images are fetched without a referrer, but avoid remote images in sensitive notes.
- **Exports you download.** A Markdown export is plain text and decrypted images. The encrypted backup stays encrypted, but anyone holding it can try passphrases offline, like a copy of the database.
- **Abuse by people you let in.** NoteFlare has no per-user quotas. Anyone your Access policy (and `ALLOWED_EMAILS`) admits can store notes until the D1 free tier runs out, so keep the policy narrow.

### What the server can and can't see

| Visible to the server (and Cloudflare) | Encrypted, never visible |
| --- | --- |
| Your Cloudflare Access email | Note titles |
| How many notes and images you have, their ids and ciphertext sizes | Note bodies and attached images |
| Created/updated timestamps and version numbers | Labels, and the file type of each image |
| Pinned, archived and trashed flags, sort position | Colors |
| Argon2id salt and parameters, wrapped (encrypted) keys | Your passphrase, recovery code and data key |
| API token names, scopes, prefixes and last-used times (token values are stored only as SHA-256 hashes) | |
| Request IPs and times, as for any Cloudflare Worker | |

The Worker makes one kind of outbound request: every few hours it asks the GitHub API for the latest NoteFlare release, so the app can show an update notice. The request contains no user data. Set `UPDATE_CHECK_REPO` to `"off"` to disable it.

### What a token can do

| | Read token | Write token | Web session |
| --- | --- | --- | --- |
| Download ciphertext and wrapped keys | ✓ | ✓ | ✓ |
| Create, update, trash or delete notes | | ✓ | ✓ |
| Change the passphrase (re-wrap keys) | | | ✓ |
| Create or revoke tokens | | | ✓ |

Tokens are accepted only on `/api/v1`, never as cookies, so they can't be used for CSRF. The web app's `/api` routes accept only a Cloudflare Access session.

## Hardening checklist for your deployment

- [ ] Cloudflare Access protects the whole Worker, with a policy that names your email(s), not "everyone".
- [ ] `ALLOWED_EMAILS` lists the same email(s) as a second lock.
- [ ] `DEV_USER_EMAIL` is not set in production (it's ignored there, but there's no reason to set it).
- [ ] If `/api/v1` uses a Bypass policy, add a Cloudflare rate-limiting rule for `/api/v1/*` (one rule is available on the free plan).
- [ ] Tokens have an expiry and the narrowest scope that works; revoke the ones you no longer use.
- [ ] Your passphrase is long (a sentence of 5+ words), and the recovery code is stored somewhere separate from it.
- [ ] You pull releases regularly; **About and updates** in the app tells you when one is out.

## Cryptography at a glance

- Passphrase → **Argon2id** (64 MiB, t=3, p=1) → key-encryption key.
- Recovery code (Crockford base32) → **HKDF-SHA256** → recovery key.
- A random 256-bit data key, wrapped with **AES-256-GCM** under each of those keys.
- Each note: **AES-256-GCM** with a random 96-bit IV and AAD `note:<id>`.
- Each attached image: **AES-256-GCM** with a random 96-bit IV and AAD `blob:<id>`; the file type is inside the ciphertext.
- In the browser the data key is a non-extractable `CryptoKey` held only in memory.
- Random 96-bit IVs are safe for far more saves than a person makes (the limit is around 2³² encryptions per key).

The implementation lives in [`packages/client/src/crypto.ts`](packages/client/src/crypto.ts), about 250 lines using WebCrypto and `hash-wasm`. **It has not been independently audited.** Review is very welcome; findings go through the private report above.
