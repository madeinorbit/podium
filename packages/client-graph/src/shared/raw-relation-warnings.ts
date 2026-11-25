/** Development guard for readers that bypass the holding model relation getters. */
import { currentDerivation, observingViews, sharingObserverWalks } from '@podium/mobx-helpers'
import { getDebugName } from 'mobx'
import { holdingInstanceOf } from './holding-relations'
import { readingModelRelation } from './model-relation-read'
import { policyRelationReader } from './policy-relation-readers'
import { rawReaderName, rawRelationReader } from './raw-relation-readers'
import { type RelationReadRow, relationReads } from './relation-reads'
import type { EntityName, ModelSchema } from './schema'
import type { LoaderInstance } from './source'

export interface RawRelationViolation {
  readonly reader: string
  readonly relation: string
}

const violations: RawRelationViolation[] = []
// side-state: identity: session-wide development diagnostic deduplication, never a pool answer
const warnedKnown = new Set<string>()

/** Test setup fails unknown reads even if a screen silences console warnings. */
export function takeRawRelationViolations(): RawRelationViolation[] {
  return violations.splice(0)
}

export class RawRelationWarnings {
  // side-state: declaration: classification of the fixed schema, used only by diagnostics
  private readonly relations: ReadonlyMap<
    string,
    RelationReadRow & {
      instance?: (owner: string) => LoaderInstance
    }
  >

  constructor(
    schema: ModelSchema,
    private readonly heldBy: (instance: LoaderInstance, view: object) => boolean,
    private readonly knownReader = rawRelationReader,
    private readonly enabled: () => boolean = () => true,
  ) {
    // side-state: declaration: classification of the fixed schema for diagnostics only
    this.relations = new Map(
      relationReads(schema).map((row) => [
        row.relation,
        {
          ...row,
          instance:
            row.read.kind === 'holding'
              ? holdingInstanceOf(schema, row.from, row.relation.slice(row.from.length + 1))
              : undefined,
        },
      ]),
    )
  }

  read(from: EntityName, id: string, relation: string): void {
    if (readingModelRelation() || !this.enabled()) return
    const row = this.relations.get(`${from}.${relation}`)
    // A relation that reads what the policy holds reads memory by design (POD-7582).
    if (row === undefined || row.read.kind === 'present' || row.read.kind === 'policy') return
    const caller = currentDerivation()
    if (caller === undefined) return
    const reader = rawReaderName(getDebugName(caller))
    // A declared reader of what the policy holds reads memory by design (POD-7581).
    if (policyRelationReader(reader, row.relation) !== undefined) return
    const known = this.knownReader(reader, row.relation)
    // POD-7608: a known reader is silent in tests and warns once elsewhere.
    // Decided here, before any walk: each walk visits every node above the
    // reader, and a deck's readers read once per row (quadratic in its rows).
    if (
      known !== undefined &&
      (process.env.NODE_ENV === 'test' || warnedKnown.has(`${reader}\0${row.relation}`))
    )
      return
    this.pending.push({
      caller,
      reader,
      relation: row.relation,
      known,
      instance: row.instance?.(id),
    })
    if (this.pending.length === 1) queueMicrotask(() => this.flush())
  }

  /** Reads to check once their tracking runs have bound, one batch per microtask. */
  private pending: PendingRead[] = []

  /** POD-7608: the batch shares its walks, so it visits each node of the graph once. */
  private flush(): void {
    const reads = this.pending
    this.pending = []
    sharingObserverWalks(() => {
      for (const read of reads) this.check(read)
    })
  }

  private check({ caller, reader, relation, known, instance }: PendingRead): void {
    for (const { view, name } of observingViews(caller)) {
      // Generated collection getters also read the raw bucket, but their
      // observing view holds its instance by the end of the tracking run.
      if (instance !== undefined && this.heldBy(instance, view)) continue
      if (known !== undefined) {
        const key = `${reader}\0${relation}`
        if (warnedKnown.has(key)) continue
        warnedKnown.add(key)
      } else if (process.env.NODE_ENV === 'test') {
        if (!violations.some((entry) => entry.reader === reader && entry.relation === relation))
          violations.push({ reader, relation })
      }
      console.warn(
        `[pool] Raw on-demand relation read: ${reader} (${name}) reads ${relation} without its holding or loading model relation getter. Read the model relation and handle LOADING.${known === undefined ? '' : ` Follow-up: ${known.followUp}.`}`,
      )
    }
  }
}

interface PendingRead {
  readonly caller: object
  readonly reader: string
  readonly relation: string
  readonly known: ReturnType<typeof rawRelationReader>
  readonly instance: LoaderInstance | undefined
}
