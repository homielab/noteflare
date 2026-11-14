# @noteflare/client

TypeScript SDK for [NoteFlare](https://github.com/homielab/noteflare), the end-to-end
encrypted notes app that runs on Cloudflare. Notes are decrypted and encrypted here,
on the client; the server only ever sees ciphertext.

Works in Node 20+, Deno, Bun, browsers and browser extensions.

```ts
import { NoteFlareClient } from '@noteflare/client'

const nf = new NoteFlareClient({ url: 'https://notes.example.com', token: 'nf_…' })
await nf.unlock('your passphrase')

for (const note of await nf.list()) console.log(note.title)
const n = await nf.create({ title: 'Groceries', body: '- [ ] milk', labels: ['home'] })
await nf.append(n.id, '- [ ] eggs')
```

- Create a token in NoteFlare under **Account → Integrations**.
- `update()` re-applies your change if another device saved first; `save()` three-way
  merges a whole edited note and throws `ConflictError` only when the same lines changed.
- Behind Cloudflare Access, allow `/api/v1` for API clients, or pass a service token:
  `new NoteFlareClient({ url, token, headers: { 'CF-Access-Client-Id': '…', 'CF-Access-Client-Secret': '…' } })`.

Full guide, endpoints and the encryption format: [docs/API.md](https://github.com/homielab/noteflare/blob/main/docs/API.md).

## Develop

```bash
bun run build:client                    # from the repository root
node packages/client/test/smoke.mjs     # end-to-end check against a running NoteFlare (see the file header)
```

MIT licensed.
