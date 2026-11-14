/**
 * Three-way merge for notes edited on two devices, like `git merge`:
 * given the version both edits started from (base), ours and theirs,
 * keep both sides' changes when they touch different parts of the note.
 *
 * Runs on decrypted content in the browser; the server never sees it.
 */
import type { NotePayload } from './crypto.js'

export interface MergeSide extends NotePayload {
  pinned: boolean
  archived: boolean
  trashedAt: number | null
  position: number
}

/** Returns the merged note, or null when both sides changed the same thing differently. */
export function mergeNotes(base: MergeSide, ours: MergeSide, theirs: MergeSide): MergeSide | null {
  const title = mergeValue(base.title, ours.title, theirs.title)
  const body = mergeText(base.body, ours.body, theirs.body)
  if (title === CONFLICT || body === null) return null
  return {
    title,
    body,
    labels: mergeSet(base.labels, ours.labels, theirs.labels),
    // For small flags, a clash isn't worth a conflict copy: the edit made here wins.
    color: pick(base.color, ours.color, theirs.color),
    pinned: pick(base.pinned, ours.pinned, theirs.pinned),
    archived: pick(base.archived, ours.archived, theirs.archived),
    trashedAt: pick(base.trashedAt, ours.trashedAt, theirs.trashedAt),
    position: pick(base.position, ours.position, theirs.position),
  }
}

const CONFLICT = Symbol('conflict')

function mergeValue<T>(base: T, ours: T, theirs: T): T | typeof CONFLICT {
  if (ours === theirs) return ours
  if (ours === base) return theirs
  if (theirs === base) return ours
  return CONFLICT
}

function pick<T>(base: T, ours: T, theirs: T): T {
  return ours === base ? theirs : ours
}

/** Labels added on either side are kept; labels removed on either side are removed. */
export function mergeSet(base: string[], ours: string[], theirs: string[]): string[] {
  const b = new Set(base)
  const o = new Set(ours)
  const t = new Set(theirs)
  const removed = new Set(base.filter((l) => !o.has(l) || !t.has(l)))
  const out: string[] = []
  for (const l of [...theirs, ...ours]) {
    if (out.includes(l)) continue
    if (b.has(l) && removed.has(l)) continue
    out.push(l)
  }
  return out
}

/** Line-based diff3. Returns null if both sides changed the same lines differently. */
export function mergeText(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours
  if (ours === base) return theirs
  if (theirs === base) return ours

  const B = base.split('\n')
  const O = ours.split('\n')
  const T = theirs.split('\n')
  // Very long notes: an exact LCS would be slow; fall back to keeping both copies.
  if (B.length * Math.max(O.length, T.length) > 4_000_000) return null

  const o = edits(B, O)
  const t = edits(B, T)
  const out: string[] = []
  for (let k = 0; k <= B.length; k++) {
    // Lines each side inserted just before base line k (or at the end).
    const io = o.ins[k]
    const it = t.ins[k]
    if (io.length || it.length) {
      if (same(io, it) || !it.length) out.push(...io)
      else if (!io.length) out.push(...it)
      // Both rewrote the same spot (deleted lines there and wrote different ones): a real conflict.
      else if (o.replaced[k] && t.replaced[k]) return null
      // One rewrote the line before this spot, the other only added after it: rewrite first, then the addition.
      else if (t.replaced[k]) out.push(...it, ...io)
      // Ours rewrote, or both only added lines here: ours first.
      else out.push(...io, ...it)
    }
    // A base line survives only if neither side deleted (or rewrote) it.
    if (k < B.length && o.kept[k] && t.kept[k]) out.push(B[k])
  }
  return out.join('\n')
}

/**
 * Describe one side as edits to the base: which base lines it kept, which lines
 * it inserted before each kept line (or at the end), and whether those
 * insertions replace lines it deleted. Merging per line — rather than per
 * changed region like classic diff3 — lets edits to adjacent lines (delete one
 * checklist item, tick the next) combine without a conflict.
 */
function edits(base: string[], side: string[]) {
  const n = base.length
  const match = lcsMatch(base, side)
  const kept = Array.from(match, (m) => m >= 0)
  const ins: string[][] = Array.from({ length: n + 1 }, () => [])
  const replaced: boolean[] = new Array(n + 1).fill(false)
  let s = 0
  let deletedRun = false
  for (let k = 0; k <= n; k++) {
    if (k < n && !kept[k]) {
      deletedRun = true
      continue
    }
    const end = k < n ? match[k] : side.length
    ins[k] = side.slice(s, end)
    replaced[k] = deletedRun && ins[k].length > 0
    s = end + 1
    deletedRun = false
  }
  return { kept, ins, replaced }
}

function same(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, k) => x === b[k])
}

/** For each line of `a`, the index of its match in `b` from a longest common subsequence, or -1. */
function lcsMatch(a: string[], b: string[]): Int32Array {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      dp[x][y] = a[x] === b[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1])
    }
  }
  const match = new Int32Array(n).fill(-1)
  let x = 0
  let y = 0
  while (x < n && y < m) {
    if (a[x] === b[y]) {
      match[x] = y
      x++
      y++
    } else if (dp[x + 1][y] >= dp[x][y + 1]) x++
    else y++
  }
  return match
}
