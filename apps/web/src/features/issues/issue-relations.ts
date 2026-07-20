import type { IssueWire } from '@podium/protocol'

/**
 * Direction of a relation entry relative to the subject issue:
 * - `'dep'`      — an outgoing dep the subject stores (subject → target).
 * - `'dependent'`— an incoming dep another issue stores toward the subject
 *                  (target → subject).
 */
export type RelationDirection = 'dep' | 'dependent'

export interface RelationEntry {
  id: string
  type: string
  direction: RelationDirection
}

export interface RelationSection {
  section: string
  entries: RelationEntry[]
}

/**
 * Dep-direction semantics (verified against `apps/server/src/issues.ts`):
 *
 * `issue.deps` are the OUTGOING deps the subject stores — each is `{ id: toId,
 * type }` for an edge `subject → toId`. `computeBlocked` (issues.ts:73-83) marks
 * the subject BLOCKED when it has a `blocks` dep whose TARGET is still open. So an
 * outgoing `blocks` dep means "subject is BLOCKED BY target" → the "Blocked by"
 * section.
 *
 * `issue.dependents` are the INCOMING deps (`{ id: fromId, type }` for an edge
 * `fromId → subject`). An incoming `blocks` dep means some other issue is blocked
 * by the subject → the subject "Blocks" it → the "Blocks" section.
 *
 * `parent-child` and `supersedes` are intentionally excluded here — the sidebar
 * renders parentage in a dedicated Parent row and supersede/duplicate state in the
 * lifecycle banner, so surfacing them again as relations would double-list them.
 */
const EXCLUDED_TYPES = new Set(['parent-child', 'supersedes'])

// Fixed leading sections, in display order. Anything not matched here falls
// through to a per-type "misc" section (label derived from the type string).
// Provenance leads (POD-85): where work came from / what came out of it is the
// first thing a reader orients by; scheduling facts follow.
const NAMED_ORDER = ['Spun off from', 'Spin-offs', 'Blocked by', 'Blocks', 'Related'] as const

/** Turn a dep type string into a human section label ('caused-by' → 'Caused by'). */
function typeLabel(type: string): string {
  const spaced = type.replace(/-/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Which section does a (type, direction) pair belong to? */
function sectionFor(type: string, direction: RelationDirection): string {
  if (type === 'blocks') return direction === 'dep' ? 'Blocked by' : 'Blocks'
  if (type === 'related') return 'Related'
  // Direction-aware provenance (POD-85): an outgoing edge names the origin this
  // issue was spun off from; an incoming one lists the work spun off of it.
  if (type === 'discovered-from') return direction === 'dep' ? 'Spun off from' : 'Spin-offs'
  return typeLabel(type)
}

/**
 * Group an issue's deps + dependents into ordered, labeled relation sections for
 * the sidebar's Relations block. Named sections ("Spun off from", "Spin-offs",
 * "Blocked by", "Blocks", "Related") come first in that order; any remaining types
 * follow, one section per type, sorted by label for a stable render. Entries are
 * de-duplicated per section by target id (a symmetric `related` edge stored on
 * both sides won't list the same issue twice). An issue with no relations returns
 * `[]`.
 */
export function groupRelations(issue: IssueWire): RelationSection[] {
  const entries: RelationEntry[] = [
    ...issue.deps.map((d) => ({ id: d.id, type: d.type, direction: 'dep' as const })),
    ...issue.dependents.map((d) => ({ id: d.id, type: d.type, direction: 'dependent' as const })),
  ].filter((e) => !EXCLUDED_TYPES.has(e.type))

  const bySection = new Map<string, RelationEntry[]>()
  for (const entry of entries) {
    const section = sectionFor(entry.type, entry.direction)
    const list = bySection.get(section) ?? []
    // Dedupe by target id within a section (symmetric edges appear on both sides).
    if (!list.some((e) => e.id === entry.id)) list.push(entry)
    bySection.set(section, list)
  }

  const misc = [...bySection.keys()]
    .filter((s) => !NAMED_ORDER.includes(s as (typeof NAMED_ORDER)[number]))
    .sort()

  return [...NAMED_ORDER, ...misc]
    .filter((s) => bySection.has(s))
    .map((section) => ({ section, entries: bySection.get(section) ?? [] }))
}
