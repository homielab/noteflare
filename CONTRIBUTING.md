# Contributing to NoteFlare

Thanks for helping. NoteFlare is small on purpose, so a good contribution is often a small one: a clearer sentence in the docs, a bug fix with a test, a translation.

## Ways to help

- **Report a bug** with the [bug template](https://github.com/homielab/noteflare/issues/new?template=bug_report.yml).
- **Suggest a feature** with the [feature template](https://github.com/homielab/noteflare/issues/new?template=feature_request.yml). For anything big, please talk it through in an issue before writing code, so nobody's work gets thrown away.
- **Review the crypto.** Read [SECURITY.md](SECURITY.md) and [`packages/client/src/crypto.ts`](packages/client/src/crypto.ts). Report weaknesses privately.
- **Translate the UI.** Copy `src/i18n/en.ts` to a new file, translate the values, and register it in `src/i18n/index.tsx` (the `Lang` type, the language list, `dicts` and `dateLocale`).
- **Build a client.** The [API guide](docs/API.md) and the `@noteflare/client` SDK are there for that. Tell us in Discussions and we'll link it.
- **Say you deployed it** in the pinned Discussions thread. NoteFlare has no telemetry, so this is how we know it works.

## Set up

You need [Bun](https://bun.sh) and Node.js 20 or newer. A Cloudflare account is only needed to deploy.

```bash
git clone https://github.com/homielab/noteflare
cd noteflare
bun install
cp dev.vars.sample .dev.vars       # sets DEV_USER_EMAIL for local login
bun run db:migrate:local
bun run dev:api                    # terminal 1: Worker + local D1 on :8787
bun run dev                        # terminal 2: Vite on :5173
```

Open http://localhost:5173. Locally you're signed in as `DEV_USER_EMAIL`; this only works while the Access variables are empty and only on `localhost` (use `localhost`, not your LAN IP, when testing on another device).

To see the offline mode, run `bun run build && bun run dev:api` and open http://localhost:8787. The service worker exists only in production builds.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit together.

## Before you open a pull request

```bash
bun run typecheck
bun run test
bun run build
bun run build:client
```

CI runs the same four commands.

- **Keep pull requests focused.** One fix or feature per PR is easier to review and to revert.
- **Add a test** for logic changes, especially in crypto, sync, merge, import or the API. Tests live in `tests/` and run with Vitest; sync tests use `fake-indexeddb`.
- **Add both languages.** Every new UI string needs a key in `src/i18n/en.ts` and `src/i18n/vi.ts`. If you don't speak Vietnamese, put the English text in `vi.ts` and say so in the PR; someone will translate it.
- **Change the database only through a new migration** in `migrations/`, numbered after the last one. Never edit a migration that has shipped.
- **Keep the API compatible.** `/api/v1` is public. Add fields rather than renaming or removing them, and update `worker/openapi.ts` and `docs/API.md` with the change.
- **Update `CHANGELOG.md`** under "Unreleased" for anything a user would notice.

## Ground rules for security-sensitive code

Changes to `packages/client/src/crypto.ts`, `worker/auth.ts`, `worker/tokens.ts` or the note wire format need extra care:

- Never send plaintext note content, the passphrase or the data key to the server, logs or analytics.
- Don't lower the KDF floor or change AAD strings without a migration path for existing vaults.
- Prefer WebCrypto over new dependencies.
- Explain the threat you considered in the PR description.

## Style

- TypeScript, strict. Match the surrounding code: two-space indent, single quotes, no semicolons.
- UI components follow shadcn/ui conventions and Tailwind tokens from `src/index.css`. Use the existing colour tokens rather than hard-coded colours.
- Motion goes through `src/lib/motion.ts`, which respects `prefers-reduced-motion`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`fix: …`, `feat: …`, `docs: …`).

## Releases

Write what changed under **Unreleased** in `CHANGELOG.md` as you go (Added, Changed, Fixed, Breaking). Then a maintainer runs:

```bash
bun run release -- patch          # or minor, major, or an exact version; add --dry-run to preview
git commit -am "chore: release vX.Y.Z" && git tag vX.Y.Z && git push && git push origin vX.Y.Z
```

`bun run release` moves the Unreleased notes under a dated heading and bumps the version in every package. Pushing the tag runs the Release workflow, which checks, builds and publishes a GitHub release with the same notes. Deployments then see the update in **About and updates**, and the app shows the notes after users update.

NoteFlare follows semantic versioning; before 1.0, minor versions may include breaking changes, which the changelog calls out.

## Code of conduct

Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

By contributing, you agree your work is released under the [MIT License](LICENSE).
