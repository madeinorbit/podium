/**
 * POD-4565 (Ma1) — the pool's models: one class per schema entity, built
 * lazily by the pool the first time a row is read (Linear's "observable on
 * first access"; audit §7). Ingest never builds a model.
 *
 * A MODEL HOLDS NO ROW. It reads its row from the pool's table on every
 * access (`row`), a tracked read of exactly that table slot, so a model
 * cannot go stale, needs no write-through, and a replaced or re-added row
 * reaches the same model. Dropping a removed row's model only frees memory.
 *
 * FIELDS FROM THE SCHEMA. Every declared field of the entity
 * (`SCHEMA[entity].fields`) is a getter on the model's prototype, installed
 * by `installFields` below from the schema itself: no field list is typed
 * here. The key field answers the model's id; every other field reads the
 * row's property of the same name, or its feed spelling (`FEED_SPELLING`).
 * `models.test.ts` iterates the schema and reads every field off a model.
 *
 * DERIVED VALUES are computed getters. The issue model's `view` (the L1b row
 * view) is assembled from per-part computeds (`views.ts` `IssueParts`), each
 * reading only its own inputs; objects are compared structurally, so an
 * unchanged part or view keeps its identity and its row does not redraw.
 */

import { computed, computedStruct, makeObservable } from 'mobx'
import type { RowOriginTick, RowView } from '../../../shared/src/row-view'
import { type EntityName, SCHEMA } from '../../../shared/src/schema'
import type { SliceIssue, SliceSession, SliceWorktree } from '../../../shared/src/slice-types'
import type { ArmStats } from '../../../shared/src/stats'
import type { StoredRow } from './tables'
import {
  activityAtPartOf,
  buildRowView,
  displayRefPartOf,
  displayTitlePartOf,
  type IssueParts,
  loadingPartOf,
  type OwnPart,
  originIdPartOf,
  originRefPartOf,
  originTickPartOf,
  ownPartOf,
  prefixPartOf,
  type RepoRow,
  repoTargetPartOf,
  sessionActivityOf,
  sessionIdsPartOf,
  type ViewInputs,
} from './views'

/**
 * Where a feed row spells a schema field differently. Only the repo: its row
 * is a root lane (`tables.ts`), which carries the repo's path as `repoPath`.
 */
export const FEED_SPELLING: Readonly<
  Partial<Record<EntityName, Readonly<Record<string, string>>>>
> = {
  repo: { path: 'repoPath' },
}

/** What a model reads from its pool. */
export interface ModelHost {
  readonly fenced: { readonly [E in EntityName]: { get(id: string): unknown } }
  readonly inputs: ViewInputs
  readonly stats: ArmStats
}

export class EntityModel {
  constructor(
    readonly entity: EntityName,
    readonly id: string,
    protected readonly host: ModelHost,
  ) {}

  /** The borrowed row, read through the pool's (fenced, tracked) table. */
  get row(): StoredRow | undefined {
    return this.host.fenced[this.entity].get(this.id) as StoredRow | undefined
  }
}

/** Install one getter per declared field of `entity` on `prototype`. */
function installFields(prototype: EntityModel, entity: EntityName): void {
  const spec = SCHEMA[entity]
  const spelling = FEED_SPELLING[entity] ?? {}
  for (const field of Object.keys(spec.fields)) {
    if (field in prototype) {
      throw new Error(`[pool] ${entity}.${field} collides with a model member; rename one`)
    }
    const property = spelling[field] ?? field
    Object.defineProperty(prototype, field, {
      configurable: false,
      enumerable: false,
      get(this: EntityModel): unknown {
        if (field === spec.key) return this.id
        const row = this.row as Readonly<Record<string, unknown>> | undefined
        return row === undefined ? undefined : row[property]
      },
    })
  }
}

export class IssueModel extends EntityModel implements IssueParts {
  constructor(id: string, host: ModelHost) {
    super('issue', id, host)
    makeObservable(this, {
      own: computedStruct,
      repoTarget: computed,
      prefix: computed,
      displayRef: computed,
      displayTitle: computed,
      originRef: computed,
      originId: computed,
      originTick: computedStruct,
      sessionIds: computedStruct,
      activityAt: computed,
      loading: computed,
      view: computedStruct,
    })
  }

  get own(): OwnPart | undefined {
    return ownPartOf(this.host.inputs, this.id)
  }

  get repoTarget(): string | null {
    return repoTargetPartOf(this.host.inputs, this.id)
  }

  get prefix(): string | null {
    return prefixPartOf(this.host.inputs, this.repoTarget)
  }

  get displayRef(): string | undefined {
    return displayRefPartOf(this.own, this.prefix)
  }

  get displayTitle(): string | undefined {
    return displayTitlePartOf(this.host.inputs, this.id, this.sessionIds)
  }

  get originRef(): string | null {
    return originRefPartOf(this.host.inputs, this.id)
  }

  get originId(): string | null {
    return originIdPartOf(this.host.inputs, this.originRef)
  }

  get originTick(): RowOriginTick | null {
    return originTickPartOf(this.host.inputs, this.originId)
  }

  get sessionIds(): readonly string[] {
    return sessionIdsPartOf(this.host.inputs, this.id)
  }

  get activityAt(): number {
    return activityAtPartOf(this.host.inputs, this.id)
  }

  get loading(): boolean {
    return loadingPartOf(this.host.inputs, this.originRef, this.sessionIds)
  }

  /** The L1b row view, from the parts above; undefined once the row has left. */
  get view(): RowView | undefined {
    this.host.stats.rowsDerived += 1
    return buildRowView(this.host.inputs, this.id, this)
  }
}

export class SessionModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('session', id, host)
    makeObservable(this, { activityMs: computed })
  }

  /** This session's contribution to its issue's `activityAt`, cached per session (POD-4568). */
  get activityMs(): number | null {
    return sessionActivityOf(this.row as SliceSession | undefined)
  }
}

export class WorktreeModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('worktree', id, host)
  }
}

export class RepoModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('repo', id, host)
  }
}

/**
 * A model with its schema getters, typed. The getters are installed from the
 * schema at runtime (`installFields`); their TYPES come from the slice types
 * the feed rows already carry, so no field list is written here.
 */
export type ModelOf = {
  issue: IssueModel & Readonly<Omit<SliceIssue, 'unread'>>
  session: SessionModel & Readonly<SliceSession>
  worktree: WorktreeModel & Readonly<Pick<SliceWorktree, 'path' | 'repoId' | 'repoPath'>>
  repo: RepoModel & Readonly<RepoRow> & { readonly path?: string }
}

/** The model class of each schema entity. */
export const MODEL_CLASSES: {
  readonly [E in EntityName]: new (
    id: string,
    host: ModelHost,
  ) => EntityModel
} = {
  issue: IssueModel,
  session: SessionModel,
  worktree: WorktreeModel,
  repo: RepoModel,
}

for (const entity of Object.keys(MODEL_CLASSES) as EntityName[]) {
  installFields(MODEL_CLASSES[entity].prototype, entity)
}
