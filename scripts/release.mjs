#!/usr/bin/env node
/**
 * Cuts a release from the "Unreleased" section of CHANGELOG.md.
 *
 *   bun run release -- patch            # 0.1.0 → 0.1.1
 *   bun run release -- minor            # 0.1.0 → 0.2.0
 *   bun run release -- 1.0.0-beta.1     # an exact version
 *   bun run release -- patch --dry-run  # show what would change
 *
 * It moves the Unreleased notes under a dated heading, updates the compare
 * links, and bumps the version in every package. Tagging and pushing stay
 * manual, so you can review the diff first; the Release workflow publishes
 * the GitHub release when the tag arrives.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseChangelog, parseVersion, isNewer } from '../shared/release.ts'

const REPO = 'https://github.com/homielab/noteflare'
const PACKAGES = ['package.json', 'packages/client/package.json', 'packages/cli/package.json']

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const bump = args.find((a) => !a.startsWith('--'))
if (!bump) fail('Say which version to release: patch, minor, major, or an exact version like 0.2.0.')

const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'))
const current = rootPkg.version
const next = nextVersion(current, bump)
if (!isNewer(next, current)) fail(`${next} is not newer than the current version ${current}.`)

const changelog = readFileSync('CHANGELOG.md', 'utf8')
const releases = parseChangelog(changelog)
if (releases.some((r) => r.version === next)) fail(`CHANGELOG.md already has a ${next} section.`)
const unreleased = releases.find((r) => r.version === 'Unreleased')
if (!unreleased) fail('CHANGELOG.md has no "## [Unreleased]" section.')
if (!unreleased.body) fail('The Unreleased section is empty. Write down what changed before releasing.')

const today = new Date().toISOString().slice(0, 10)
let updated = changelog.replace(/^## \[Unreleased\][^\n]*$/m, `## [Unreleased]\n\n## [${next}] - ${today}`)
updated = updated.replace(/^\[Unreleased\]:.*$/m, `[Unreleased]: ${REPO}/compare/v${next}...HEAD\n[${next}]: ${REPO}/compare/v${current}...v${next}`)
if (!/^\[Unreleased\]:/m.test(changelog)) updated = updated.trimEnd() + `\n\n[Unreleased]: ${REPO}/compare/v${next}...HEAD\n[${next}]: ${REPO}/compare/v${current}...v${next}\n`

console.log(`Releasing ${current} → ${next} (${today})\n`)
console.log(unreleased.body.replace(/^/gm, '  ') + '\n')

if (dry) {
  console.log('Dry run: nothing was written.')
  process.exit(0)
}

writeFileSync('CHANGELOG.md', updated)
for (const file of PACKAGES) {
  const raw = readFileSync(file, 'utf8')
  writeFileSync(file, raw.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`))
}
console.log(`Updated CHANGELOG.md, ${PACKAGES.join(', ')}.

Next:
  git diff                                   # review
  bun run typecheck && bun run test && bun run build
  git commit -am "chore: release v${next}"
  git tag v${next}
  git push && git push origin v${next}       # the Release workflow publishes it on GitHub
`)

function nextVersion(cur, how) {
  const v = parseVersion(cur)
  if (!v) fail(`package.json has an invalid version: ${cur}`)
  if (how === 'major') return `${v.major + 1}.0.0`
  if (how === 'minor') return `${v.major}.${v.minor + 1}.0`
  if (how === 'patch') return v.pre ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch + 1}`
  const exact = how.replace(/^v/, '')
  if (!parseVersion(exact)) fail(`"${how}" is not patch, minor, major or a version like 1.2.3.`)
  return exact
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}
