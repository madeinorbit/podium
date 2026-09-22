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
 * DERIVED VALUES are computed getters. Ma1 has one, `IssueModel.view` (the
 * L1b row view), compared structurally so an unchanged view keeps its
 * identity and its row does not redraw.
 */

import { computedStruct, makeObservable } from 'mobx'
import type { RowView } from '../../../shared/src/row-view'
import { type EntityName, SCHEMA } from '../../../shared/src/schema'
import type { SliceIssue, SliceSession, SliceWorktree } from '../../../shared/src/slice-types'
import type { ArmStats } from '../../../shared/src/stats'
import type { StoredRow } from './tables'
import { buildRowView, type RepoRow, type ViewInputs } from './views'

/**
 * Where a feed row spells a schema field differently. Only the repo: its row
 * is a root lane (`tables.ts`), which carries the repo's path as `repoPath`.
 */
export const FEED_SPELLING: Readonly<Partial<Record<EntityName, Readonly<Record<string, string>>>>> = {
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

// The declared fields, typed from the slice types the feed rows already have
// (the runtime getters come from the schema; see `installFields`).

export interface IssueModel extends Readonly<Omit<SliceIssue, 'unread'>> {}
export class IssueModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('issue', id, host)
    makeObservable(this, { view: computedStruct })
  }

  /** The L1b row view (`views.ts`); undefined once the row has left. */
  get view(): RowView | undefined {
    this.host.stats.rowsDerived += 1
    return buildRowView(this.host.inputs, this.id)
  }
}

export interface SessionModel extends Readonly<SliceSession> {}
export class SessionModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('session', id, host)
  }
}

export interface WorktreeModel extends Readonly<Pick<SliceWorktree, 'path' | 'repoId' | 'repoPath'>> {}
export class WorktreeModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('worktree', id, host)
  }
}

export interface RepoModel extends Readonly<RepoRow> {
  readonly path?: string
}
export class RepoModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('repo', id, host)
  }
}

export type ModelOf = {
  issue: IssueModel
  session: SessionModel
  worktree: WorktreeModel
  repo: RepoModel
}

/** The model class of each schema entity. */
export const MODEL_CLASSES: { readonly [E in EntityName]: new (id: string, host: ModelHost) => ModelOf[E] } = {
  issue: IssueModel,
  session: SessionModel,
  worktree: WorktreeModel,
  repo: RepoModel,
}

for (const entity of Object.keys(MODEL_CLASSES) as EntityName[]) {
  installFields(MODEL_CLASSES[entity].prototype, entity)
}
