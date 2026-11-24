/** Development guard for readers that bypass the holding model relation getters. */
import { currentDerivation, observingViews } from '@podium/mobx-helpers'
import { getDebugName } from 'mobx'
import { holdingInstanceOf } from './holding-relations'
import { readingModelRelation } from './model-relation-read'
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
    if (row === undefined || row.read.kind === 'present') return
    const caller = currentDerivation()
    if (caller === undefined) return
    const reader = rawReaderName(getDebugName(caller))
    const instance = row.instance?.(id)
    queueMicrotask(() => {
      for (const { view, name } of observingViews(caller)) {
        // Generated collection getters also read the raw bucket, but their
        // observing view holds its instance by the end of the tracking run.
        if (instance !== undefined && this.heldBy(instance, view)) continue
        const known = this.knownReader(reader, row.relation)
        if (known !== undefined) {
          if (process.env.NODE_ENV === 'test') continue
          const key = `${reader}\0${row.relation}`
          if (warnedKnown.has(key)) continue
          warnedKnown.add(key)
        } else if (process.env.NODE_ENV === 'test') {
          if (
            !violations.some((entry) => entry.reader === reader && entry.relation === row.relation)
          )
            violations.push({ reader, relation: row.relation })
        }
        console.warn(
          `[pool] Raw on-demand relation read: ${reader} (${name}) reads ${row.relation} without its holding or loading model relation getter. Read the model relation and handle LOADING.${known === undefined ? '' : ` Follow-up: ${known.followUp}.`}`,
        )
      }
    })
  }
}
