/**
 * THE SHADOW-COMPARISON CLASSIFIER (POD-1223).
 *
 * `docs/agents/pod-376-shadow-comparison-basis.md` §2.2 defines this table, and
 * that document is the authority: "if the harness and this document ever
 * disagree, the harness is wrong." This module is the table, written as a TOTAL
 * function so `unclassified` is a reachable, FAILING outcome rather than a gap
 * in an if-chain.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT KEEPS THIS FROM BEING A RUBBER STAMP
 * ---------------------------------------------------------------------------
 *
 * `scoped-out` requires the row to be ABSENT FROM `A` — the Authority must
 * affirm the row is outside this principal's slice. A blanket "absent from the
 * kernel path is fine" rule would classify `kernel-missing` — real data loss —
 * as an expected scoping difference, which is exactly the bug class this
 * comparison exists to catch. Nothing here suppresses an absence; it attributes
 * it, and an absence it cannot attribute to `A` fails.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT IN THE TABLE, AND STAYS `unclassified`
 * ---------------------------------------------------------------------------
 *
 * A key in `K` and `A` but NOT in `L` — the LEGACY path missing a row it is
 * entitled to — has no row in §2.2. It is a real difference and it falls to
 * `unclassified`, which fails. That is the document's instruction ("reported as
 * a hole in this table"), not an oversight here: inventing a `legacy-missing`
 * class would be the harness quietly amending the basis it was told to
 * implement. If it fires in practice, the basis document gains a row and this
 * function follows it — in that order.
 *
 * PROVENANCE IS EXCLUDED FROM THE DIGEST (§2.1). ADR 2 D8 puts `originId` /
 * `causationId` / `mutationId` on the envelope precisely so byte-equality does
 * not fire on provenance churn, and the two paths legitimately carry different
 * provenance for the same row.
 */

export type DivergenceClass =
  | 'agree'
  | 'scoped-out'
  | 'kernel-leak'
  | 'legacy-leak'
  | 'kernel-missing'
  | 'content-drift'
  | 'revision-drift'
  | 'unclassified'

/** The classes that FAIL the gate. `agree` and `scoped-out` are the only two
 *  outcomes that do not, and they are listed by exclusion so a new class added
 *  to the union above defaults to failing. */
export const PASSING_CLASSES: ReadonlySet<DivergenceClass> = new Set<DivergenceClass>([
  'agree',
  'scoped-out',
])

export const isDivergence = (klass: DivergenceClass): boolean => !PASSING_CLASSES.has(klass)

/** One row as a snapshot holds it: an opaque revision plus a content digest. */
export interface SnapshotEntry {
  readonly revision?: number
  readonly digest: string
}

/** `(entity, entityId)` → entry. The key format is `${entity}:${entityId}`. */
export type Snapshot = ReadonlyMap<string, SnapshotEntry>

export interface ClassifyInput {
  readonly kernel: Snapshot
  readonly legacy: Snapshot
  readonly authority: Snapshot
  /**
   * True when the Authority evaluates visibility PER PRINCIPAL.
   *
   * It changes one verdict: against a scoped authority, a row the legacy path
   * holds and the Authority does not is a `legacy-leak` — the off-flag path
   * showing what it may not see — rather than a benign `scoped-out`. In practice
   * `resolveReplicaMode` refuses to run the shadow at all against a scoped
   * authority (the second connection would be refused at the wire), so this arm
   * is defence in depth rather than a live path.
   */
  readonly authorityScoped: boolean
}

export interface Classification {
  readonly key: string
  readonly class: DivergenceClass
  /** Present on the drift classes, so a report says WHAT differed. */
  readonly detail?: string
}

export function classifyKey(key: string, input: ClassifyInput): Classification {
  const k = input.kernel.get(key)
  const l = input.legacy.get(key)
  const a = input.authority.get(key)

  // Leaks first: a path holding a row the Authority says is outside the slice is
  // the most serious outcome, and it must not be masked by a drift comparison.
  if (k !== undefined && a === undefined) return { key, class: 'kernel-leak' }
  if (l !== undefined && a === undefined && input.authorityScoped) {
    return { key, class: 'legacy-leak' }
  }
  // Data loss next.
  if (a !== undefined && k === undefined) return { key, class: 'kernel-missing' }
  // The one expected difference: the Authority AFFIRMS this row is outside the
  // slice, so the kernel path correctly does not hold it.
  if (l !== undefined && k === undefined && a === undefined) return { key, class: 'scoped-out' }

  if (k !== undefined && l !== undefined && a !== undefined) {
    if (k.digest !== l.digest) {
      return { key, class: 'content-drift', detail: `kernel=${k.digest} legacy=${l.digest}` }
    }
    if (k.revision !== l.revision) {
      return {
        key,
        class: 'revision-drift',
        detail: `kernel=${String(k.revision)} legacy=${String(l.revision)}`,
      }
    }
    return { key, class: 'agree' }
  }

  return { key, class: 'unclassified' }
}

export interface ShadowSample {
  readonly classifications: readonly Classification[]
  readonly divergences: readonly Classification[]
  readonly counts: Readonly<Record<DivergenceClass, number>>
}

/** Classify EVERY key in K ∪ L ∪ A (§2.2 — "every key", not the intersection). */
export function classifySample(input: ClassifyInput): ShadowSample {
  const keys = new Set<string>([
    ...input.kernel.keys(),
    ...input.legacy.keys(),
    ...input.authority.keys(),
  ])
  const classifications = [...keys].sort().map((key) => classifyKey(key, input))
  const counts = {
    agree: 0,
    'scoped-out': 0,
    'kernel-leak': 0,
    'legacy-leak': 0,
    'kernel-missing': 0,
    'content-drift': 0,
    'revision-drift': 0,
    unclassified: 0,
  } satisfies Record<DivergenceClass, number>
  for (const c of classifications) counts[c.class] += 1
  return {
    classifications,
    divergences: classifications.filter((c) => isDivergence(c.class)),
    counts,
  }
}

/**
 * Store bookkeeping, excluded from the digest on BOTH sides.
 *
 * FOUND BY THE HARNESS, not reasoned about in advance: the first two-connection
 * run reported `content-drift` on a row both paths held identically, because the
 * legacy row carried TanStack's `$collectionId` / `$key` / `$origin` / `$synced`
 * alongside the wire fields — and `$collectionId` embeds a per-instance nonce,
 * so it can NEVER agree. Including them would have made every row diverge, which
 * is as useless a comparison as one that passes on everything.
 *
 * The exclusion is by PREFIX and symmetric. Symmetric matters: a filter applied
 * to one side only could manufacture agreement in one direction. No authority
 * row has a `$`-prefixed field — these are storage-layer bookkeeping, the same
 * category as the provenance §2.1 already excludes — so nothing the Authority
 * can say is being dropped here.
 */
const STORE_BOOKKEEPING_PREFIX = '$'

/**
 * A stable content digest.
 *
 * Object keys are emitted in sorted order at every level, because two paths that
 * built the same row from different sources have no reason to agree on key
 * ORDER, and a digest that changed with key order would report every row as
 * `content-drift` — a comparison that fails on everything is as useless as one
 * that passes on everything.
 */
export function contentDigest(value: unknown): string {
  return canonical(value)
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(record).sort()) {
    if (key.startsWith(STORE_BOOKKEEPING_PREFIX)) continue
    // An absent field and a field explicitly set to `undefined` are the same
    // row; JSON.stringify already drops the latter, so this matches it.
    if (record[key] === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonical(record[key])}`)
  }
  return `{${parts.join(',')}}`
}

export const snapshotKey = (entity: string, entityId: string): string => `${entity}:${entityId}`
