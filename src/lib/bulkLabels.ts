interface Labelled {
  id: string
  labels: string[]
}

export interface LabelChange {
  id: string
  labels: string[]
  previous: string[]
}

/** Labels that every one of the notes has (none for an empty list). */
export function commonLabels(notes: readonly Labelled[]): string[] {
  if (!notes.length) return []
  const [first, ...rest] = notes
  return first.labels.filter((l) => rest.every((n) => n.labels.includes(l)))
}

/** What to write so that all notes have `label` (add) or none has it (remove); notes already right are left out. */
export function bulkLabelChanges(notes: readonly Labelled[], label: string, add: boolean): LabelChange[] {
  const changes: LabelChange[] = []
  for (const n of notes) {
    const has = n.labels.includes(label)
    if (add && !has) changes.push({ id: n.id, labels: [...n.labels, label], previous: n.labels })
    else if (!add && has) changes.push({ id: n.id, labels: n.labels.filter((l) => l !== label), previous: n.labels })
  }
  return changes
}

/**
 * What undoes `changes` on the notes as they are now. A note untouched since gets its previous labels back;
 * one whose labels changed meanwhile only has `label` put back or taken off, so the later change is kept.
 */
export function undoLabelChanges(
  changes: readonly LabelChange[],
  current: (id: string) => Labelled | undefined,
  label: string,
  added: boolean,
): LabelChange[] {
  const undo: LabelChange[] = []
  for (const c of changes) {
    const now = current(c.id)
    if (!now) continue
    const untouched = now.labels.length === c.labels.length && now.labels.every((l, i) => l === c.labels[i])
    if (untouched) undo.push({ id: c.id, labels: c.previous, previous: now.labels })
    else undo.push(...bulkLabelChanges([now], label, !added))
  }
  return undo
}

/**
 * What to write so `from` becomes `to` on every note that has `from`. `to` takes `from`'s place in the list;
 * a note that already has `to` only loses `from` (merge), so no note ends with a duplicate. Notes without `from` are left out.
 */
export function renameLabelChanges(notes: readonly Labelled[], from: string, to: string): LabelChange[] {
  if (from === to) return []
  const changes: LabelChange[] = []
  for (const n of notes) {
    if (!n.labels.includes(from)) continue
    const labels = n.labels.includes(to) ? n.labels.filter((l) => l !== from) : n.labels.map((l) => (l === from ? to : l))
    changes.push({ id: n.id, labels, previous: n.labels })
  }
  return changes
}

/** What undoes `changes` on the notes as they are now: a note changed since, or gone, is left alone. */
export function restoreLabelChanges(changes: readonly LabelChange[], current: (id: string) => Labelled | undefined): LabelChange[] {
  const out: LabelChange[] = []
  for (const c of changes) {
    const now = current(c.id)
    if (now && now.labels.length === c.labels.length && now.labels.every((l, i) => l === c.labels[i])) {
      out.push({ id: c.id, labels: c.previous, previous: now.labels })
    }
  }
  return out
}

/** The spelling to rename to: an existing label (other than `from`) that differs from `typed` only by case wins. */
export function resolveLabel(typed: string, existing: readonly string[], from: string): string {
  const to = typed.trim()
  const lower = to.toLowerCase()
  return existing.find((l) => l !== from && l.toLowerCase() === lower) ?? to
}
