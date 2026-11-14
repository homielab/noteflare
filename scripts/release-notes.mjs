#!/usr/bin/env node
/**
 * Prints the CHANGELOG.md section for one version, for the GitHub release body.
 * Fails when the version has no section, so a tag can't be published without notes.
 *
 *   node scripts/release-notes.mjs v0.2.0
 */
import { readFileSync } from 'node:fs'
import { parseChangelog } from '../shared/release.ts'

const version = (process.argv[2] ?? '').replace(/^v/, '')
const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
if (!version) fail('Pass the version, e.g. v0.2.0.')
if (version !== pkgVersion) fail(`Tag v${version} doesn't match package.json (${pkgVersion}). Run bun run release first.`)

const release = parseChangelog(readFileSync('CHANGELOG.md', 'utf8')).find((r) => r.version === version)
if (!release?.body) fail(`CHANGELOG.md has no notes for ${version}.`)

process.stdout.write(
  `${release.body}\n\n---\n\n**Update your deployment:** if you used the Deploy button, open **Actions → Update NoteFlare → Run workflow** in your copy; from the command line, pull this release and run \`bun run deploy\`. ` +
    `See [Update](https://github.com/homielab/noteflare#-update) in the README.\n`,
)

function fail(message) {
  console.error(`release-notes: ${message}`)
  process.exit(1)
}
