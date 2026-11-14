## What this changes

<!-- One or two sentences. Link the issue: "Closes #123". -->

## Why

## How I tested it

<!-- Commands you ran, browsers you checked, screenshots for UI changes. -->

## Checklist

- [ ] `bun run typecheck`, `bun run test`, `bun run build` and `bun run build:client` pass
- [ ] Tests added or updated for logic changes
- [ ] New UI strings added to both `src/i18n/en.ts` and `src/i18n/vi.ts`
- [ ] Schema changes are a new file in `migrations/`
- [ ] `/api/v1` changes are backward compatible and reflected in `worker/openapi.ts` and `docs/API.md`
- [ ] `CHANGELOG.md` updated under "Unreleased" if users will notice
- [ ] No plaintext note content, passphrase or keys can reach the server or logs
