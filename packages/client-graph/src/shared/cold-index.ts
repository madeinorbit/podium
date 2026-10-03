/**
 * POD-5405 — THE COLD INDEX: the residency rule's inputs for every row the
 * feed carries, held outside the pool, behind declared questions.
 *
 * WHY. A pool's attach used to place every replica row by the rule
 * (`enumerate.ts` `reseed`), so its cost grew with history: 99% of the phone's
 * 11k rows are cold (POD-5391). To attach with the resident rows only, some
 * component must answer "is this row cold by the rule, now?" and "which rows
 * are not?" for rows the pool never placed. This is that component.
 *
 * WHAT IT HOLDS. Per row of a cold-capable entity, the RULE ROW: only the
 * declared fields `coldByRule` reads of it (`dependsOn`, `canShow.fields`,
 * the key, a lane's `through` key, a `via` foreign key and its `unbound`
 * fields), never the row. Per member row, its computed keep (`keeperOf`,
 * `laneKeepOf`) and the facts that seat it in a lane (its normalized path, the
 * prefix's `where`, its collapse fields). Plus the indexes the rule asks
 * through: members' keeps by owner, lane seats by root, a `via` entity's rows
 * by target, and the rows whose deadlines have not yet all passed.
 *
 * ONE RULE. Every answer evaluates the schema's own `coldByRule` against a
 * held rule row, through a `ColdContext` backed by these indexes. Nothing
 * here restates the rule: a rule change in `schema.ts` needs no change here
 * unless it reads a field its declaration does not list (the equality proof
 * against `tableColdContext` over whole rows catches that).
 *
 * WHAT IT CONSUMES. The row source's publications, exactly as a pool does:
 * one `replace` (or a seeding snapshot), then `update`s, record by record
 * (`value: undefined` removes). It therefore knows what a pool that placed
 * every row would know, and nothing it was not told.
 *
 * DECLARED QUESTIONS ONLY (POD-4286's cutoff rule). Readers receive
 * {@link ColdQueries}, never a map. A later memory cutoff can answer the
 * same questions from storage.
 *
 * COST. A publication costs O(its records) plus the bounded fan-out the rule
 * already implies: a member's owner, a lane root's members, a collapse group,
 * a target's dependents. `residentCandidates` visits the rows that are open
 * or whose latest deadline is still ahead (a superset of the resident rows),
 * never the cold rest. The one exception is a clock rewind below the highest
 * clock it has answered for. Expiry is monotone (deadlines only pass), so it
 * then rescans every held row once.
 */

import {
  type CollapseMember,
  type CollapseSpec,
  type ColdContext,
  type ColdSpec,
  coldByRule,
  collapseLosers,
  type EntityName,
  keeperOf,
  keepDeadline,
  keptByKey,
  type KeptBySpec,
  laneKeepOf,
  type LaneSource,
  laneSources,
  type MemberKeep,
  type ModelSchema,
  normalizeRootPath,
  prefixCandidates,
  extraRootOf,
  viaTargetOf,
} from './schema'
import type { RowRecord, RowSourceEvent } from './source'
import { createReaderIndex, type ReaderQuestion } from './reader-questions'

type Row = Readonly<Record<string, unknown>>

/** The questions the cold index answers. The only surface readers get. */
export interface ColdQueries {
  /** Publications applied so far: a reader's memo key. */
  readonly version: number
  /** Whether the feed carries the row (any entity the index tracks). */
  known(entity: EntityName, id: string): boolean
  /** How many rows of `entity` the feed carries. */
  count(entity: EntityName): number
  /** `coldByRule` for the row at `now` (false for an unknown row or a never-cold entity). */
  coldByRule(entity: EntityName, id: string, now: number): boolean
  /**
   * Every known row of a cold-capable entity that is NOT cold by rule at
   * `now`, in no particular order. Visits only rows that are open or have a
   * deadline at or after `now`, not the cold rest.
   */
  residentCandidates(entity: EntityName, now: number): string[]
  /** Membership/order changes relevant to history readers (not heartbeats). */
  readonly readerVersion: number
  readerRevision(question: ReaderQuestion): number
  readonly issueRepoRevision: number
  readonly sessionRevision: number
  readerIds(question: ReaderQuestion): string[]
  issueRepoIds(): string[]
  sessionCollapsed(id: string): boolean
  sessionOrderKey(id: string): string
}

export interface ColdIndex extends ColdQueries {
  apply(event: RowSourceEvent): void
}

/** A member's lane facts: where it may sit and what it keeps there. */
interface LaneMember {
  /** The normalized source path, or null when the row has none. */
  readonly path: string | null
  /** `laneKeepOf` when the prefix's `where` passes, else null (never a member). */
  readonly keep: MemberKeep | null
}

interface LaneState {
  readonly lane: LaneSource
  /** Raw root → how many sources name it (lane rows, each `alsoRoots` row). */
  readonly roots: Map<string, number>
  /** Per alsoRoots row (`entity:id`), the raw root it contributes. */
  readonly extraOf: Map<string, string>
  readonly members: Map<string, LaneMember>
  /** Root candidate spelling → eligible members whose path could sit under it. */
  readonly under: Map<string, Set<string>>
  /** Member → the root it sits at, while it is seated. */
  readonly seat: Map<string, string>
  /** Root → seated members' keeps (what `ctx.keeps` reads for this source). */
  readonly keeps: Map<string, Map<string, MemberKeep>>
}

interface CollapseState {
  readonly rule: CollapseSpec
  readonly fields: readonly string[]
  readonly groups: Map<string, Map<string, Row>>
  readonly groupOf: Map<string, string>
  readonly collapsed: Set<string>
  readonly orderKeys: Map<string, string>
}

const NO_KEEPS: readonly MemberKeep[] = []

function pick(row: Row, fields: readonly string[]): Row {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const value = row[field]
    if (value !== undefined) out[field] = value
  }
  return out
}

/** The fields `coldByRule` reads of a row of `entity`, from its declaration. */
function ruleFields(schema: ModelSchema, entity: EntityName, lanes: readonly LaneSource[]): string[] {
  const spec: ColdSpec = schema[entity].cold
  const fields = new Set<string>([schema[entity].key])
  if (spec.kind === 'own') for (const field of spec.dependsOn) fields.add(field)
  if (spec.kind === 'unlessShown') {
    for (const field of spec.dependsOn) fields.add(field)
    for (const field of spec.canShow?.fields ?? []) fields.add(field)
    for (const lane of lanes) if (lane.owner === entity) fields.add(lane.through.foreignKey)
  }
  if (spec.kind === 'via') {
    const relation = schema[entity].relations[spec.relation]
    if (relation?.kind === 'belongsTo') fields.add(relation.foreignKey)
    for (const field of spec.unbound?.dependsOn ?? []) fields.add(field)
  }
  return [...fields]
}

export function createColdIndex(schema: ModelSchema): ColdIndex {
  const readers = createReaderIndex()
  let collapseVersion = 0
  const lanes = laneSources(schema)
  const entities = (Object.keys(schema) as EntityName[]).filter(
    (entity) => schema[entity].cold.kind !== 'never',
  )
  const fieldsOf = new Map(entities.map((entity) => [entity, ruleFields(schema, entity, lanes)]))
  /** Cold-capable entity → id → rule row. */
  const rules = new Map<EntityName, Map<string, Row>>(entities.map((entity) => [entity, new Map()]))
  /** Lane-target entities (`worktree`): ids only, as roots. */
  const plain = new Map<EntityName, Set<string>>()

  // Members sources: source → owner id → member id → keep; member → where it is filed.
  const byOwner = new Map<KeptBySpec, Map<string, Map<string, MemberKeep>>>()
  const memberOf = new Map<string, { readonly source: KeptBySpec; readonly owner: string }>()

  const laneStates: LaneState[] = lanes.map((lane) => ({
    lane,
    roots: new Map(),
    extraOf: new Map(),
    members: new Map(),
    under: new Map(),
    seat: new Map(),
    keeps: new Map(),
  }))
  for (const state of laneStates) {
    if (!plain.has(state.lane.prefix.to)) plain.set(state.lane.prefix.to, new Set())
  }
  const collapses = new Map<EntityName, CollapseState>()
  for (const state of laneStates) {
    const rule = schema[state.lane.member].collapse
    if (rule === undefined || collapses.has(state.lane.member)) continue
    collapses.set(state.lane.member, {
      rule,
      fields: [...new Set([...rule.fields, rule.recency])],
      groups: new Map(),
      groupOf: new Map(),
      collapsed: new Set(),
      orderKeys: new Map(),
    })
  }

  // `via` entities: target id → the ids naming it by the raw foreign key.
  const byTarget = new Map<EntityName, Map<string, Set<string>>>()
  for (const entity of entities) if (schema[entity].cold.kind === 'via') byTarget.set(entity, new Map())

  // Deadlines. `alive`: unlessShown rows whose predicate holds and whose latest
  // deadline (own or any keeper's, canShow aside) is at or after `high`.
  // `open`: rows whose predicate does not hold (never cold). `unboundAlive`:
  // `via` rows with no target that are not yet past their own decay.
  const open = new Map<EntityName, Set<string>>()
  const alive = new Map<EntityName, Map<string, number>>()
  const unboundAlive = new Map<EntityName, Map<string, number>>()
  for (const entity of entities) {
    const kind = schema[entity].cold.kind
    if (kind === 'unlessShown' || kind === 'own') {
      open.set(entity, new Set())
      alive.set(entity, new Map())
    }
    if (kind === 'via') unboundAlive.set(entity, new Map())
  }
  let high = Number.NEGATIVE_INFINITY
  let version = 0

  // ------------------------------------------------------------- context

  function context(now: number): ColdContext {
    const memo = new Map<string, boolean>()
    const ctx: ColdContext = {
      now,
      summary: (entity, id) => {
        const spec = schema[entity].cold
        const row = rules.get(entity)?.get(id)
        if (row === undefined || spec.kind !== 'unlessShown' || spec.canShow === undefined) return undefined
        return Object.fromEntries(spec.canShow.fields.map((field) => [field, row[field]]))
      },
      coldTarget: (to, id) => {
        const key = `${to}:${id}`
        const known = memo.get(key)
        if (known !== undefined) return known
        const row = rules.get(to)?.get(id)
        const cold = row !== undefined && coldByRule(schema, to, row, ctx)
        memo.set(key, cold)
        return cold
      },
      keeps: (_entity, source, key) => keepsAt(source, key),
    }
    return ctx
  }

  function keepsAt(source: KeptBySpec, key: string): Iterable<MemberKeep> {
    if (source.kind === 'members') return byOwner.get(source)?.get(key)?.values() ?? NO_KEEPS
    const state = laneStates.find((found) => found.lane.source === source)
    return state?.keeps.get(key)?.values() ?? NO_KEEPS
  }

  // ------------------------------------------------------------- deadlines

  /** The latest instant anything could show `id` (canShow aside), for an unlessShown row. */
  function latest(entity: EntityName, row: Row): number {
    const spec = schema[entity].cold
    if (spec.kind !== 'unlessShown') return Number.POSITIVE_INFINITY
    let until = spec.shownUntil(row)
    const finish = spec.finishOf(row)
    for (const source of spec.keptBy) {
      const key = keptByKey(schema, entity, row, source)
      if (key === null) continue
      for (const keep of keepsAt(source, key)) until = Math.max(until, keepDeadline(keep, finish))
    }
    return until
  }

  /** Re-file `id` of an unlessShown/own entity in `open` / `alive` from its current inputs. */
  function refile(entity: EntityName, id: string): void {
    const openSet = open.get(entity)
    const aliveMap = alive.get(entity)
    if (openSet === undefined || aliveMap === undefined) return
    openSet.delete(id)
    aliveMap.delete(id)
    const row = rules.get(entity)?.get(id)
    if (row === undefined) return
    const spec = schema[entity].cold
    if (spec.kind === 'own') {
      if (!spec.predicate(row)) openSet.add(id)
      return
    }
    if (spec.kind !== 'unlessShown') return
    if (!spec.predicate(row)) {
      openSet.add(id)
      return
    }
    const until = latest(entity, row)
    if (until > Number.NEGATIVE_INFINITY && until >= high) aliveMap.set(id, until)
  }

  function refileUnbound(entity: EntityName, id: string, row: Row | undefined): void {
    const map = unboundAlive.get(entity)
    if (map === undefined) return
    map.delete(id)
    const spec = schema[entity].cold
    if (row === undefined || spec.kind !== 'via' || viaTargetOf(schema, entity, row) !== null) return
    const until = spec.unbound === undefined || !spec.unbound.predicate(row)
      ? Number.POSITIVE_INFINITY
      : spec.unbound.shownUntil(row)
    if (until > Number.NEGATIVE_INFINITY && until >= high) map.set(id, until)
  }

  // ------------------------------------------------------------- lanes

  function seatOf(state: LaneState, id: string): string | null {
    const member = state.members.get(id)
    if (member === undefined || member.keep === null || member.path === null) return null
    if (collapses.get(state.lane.member)?.collapsed.has(id)) return null
    for (const candidate of prefixCandidates(member.path)) {
      if (state.roots.has(candidate)) return candidate
    }
    return null
  }

  /** Owners whose lane key is `root` (their deadlines read its keeps). */
  function ownersAt(state: LaneState, root: string): void {
    const owner = state.lane.owner
    const ids = laneOwners.get(state)?.get(root)
    for (const id of ids ?? []) refile(owner, id)
  }

  function reseat(state: LaneState, id: string): void {
    const before = state.seat.get(id) ?? null
    const after = seatOf(state, id)
    const keep = state.members.get(id)?.keep ?? null
    if (before !== null) {
      const keeps = state.keeps.get(before)
      keeps?.delete(id)
      if (keeps?.size === 0) state.keeps.delete(before)
      state.seat.delete(id)
    }
    if (after !== null && keep !== null) {
      let keeps = state.keeps.get(after)
      if (keeps === undefined) {
        keeps = new Map()
        state.keeps.set(after, keeps)
      }
      keeps.set(id, keep)
      state.seat.set(id, after)
    }
    if (before !== null) ownersAt(state, before)
    if (after !== null && after !== before) ownersAt(state, after)
  }

  function addRoot(state: LaneState, root: string): void {
    const count = state.roots.get(root) ?? 0
    state.roots.set(root, count + 1)
    if (count === 0) for (const id of [...(state.under.get(root) ?? [])]) reseat(state, id)
  }

  function removeRoot(state: LaneState, root: string): void {
    const count = state.roots.get(root) ?? 0
    if (count <= 1) {
      state.roots.delete(root)
      if (count === 1) for (const id of [...(state.under.get(root) ?? [])]) reseat(state, id)
    } else state.roots.set(root, count - 1)
  }

  function setLaneMember(state: LaneState, id: string, row: Row | undefined): void {
    const previous = state.members.get(id)
    if (previous?.path != null && previous.keep !== null) {
      for (const candidate of prefixCandidates(previous.path)) {
        const ids = state.under.get(candidate)
        ids?.delete(id)
        if (ids?.size === 0) state.under.delete(candidate)
      }
    }
    if (row === undefined) state.members.delete(id)
    else {
      const prefix = state.lane.prefix
      const where = prefix.where === undefined || prefix.where.test(row)
      const raw = row[prefix.sourceField]
      const member: LaneMember = {
        path: typeof raw === 'string' ? normalizeRootPath(raw) : null,
        keep: where ? laneKeepOf(state.lane, row) : null,
      }
      state.members.set(id, member)
      if (member.path !== null && member.keep !== null) {
        for (const candidate of prefixCandidates(member.path)) {
          let ids = state.under.get(candidate)
          if (ids === undefined) {
            ids = new Set()
            state.under.set(candidate, ids)
          }
          ids.add(id)
        }
      }
    }
    reseat(state, id)
  }

  /** Lane owners by the raw lane key their `through` foreign key names. */
  const laneOwners = new Map<LaneState, Map<string, Set<string>>>(laneStates.map((state) => [state, new Map()]))
  const laneKeyOf = new Map<LaneState, Map<string, string>>(laneStates.map((state) => [state, new Map()]))

  function setLaneOwner(state: LaneState, id: string, row: Row | undefined): void {
    const keys = laneKeyOf.get(state)!
    const owners = laneOwners.get(state)!
    const before = keys.get(id)
    if (before !== undefined) {
      const ids = owners.get(before)
      ids?.delete(id)
      if (ids?.size === 0) owners.delete(before)
      keys.delete(id)
    }
    const value = row?.[state.lane.through.foreignKey]
    if (typeof value === 'string' && value.length > 0) {
      keys.set(id, value)
      let ids = owners.get(value)
      if (ids === undefined) {
        ids = new Set()
        owners.set(value, ids)
      }
      ids.add(id)
    }
  }

  function setExtraRoot(state: LaneState, entity: EntityName, id: string, row: Row | undefined): void {
    for (const source of state.lane.prefix.alsoRoots ?? []) {
      if (source.entity !== entity) continue
      const key = `${entity}:${id}:${source.field}`
      const before = state.extraOf.get(key)
      const after = row === undefined ? null : extraRootOf(source, row)
      if (before === (after ?? undefined)) continue
      if (after !== null) {
        state.extraOf.set(key, after)
        addRoot(state, after)
      } else state.extraOf.delete(key)
      if (before !== undefined) removeRoot(state, before)
    }
  }

  // ------------------------------------------------------------- collapse

  function setCollapse(entity: EntityName, id: string, row: Row | undefined): void {
    const state = collapses.get(entity)
    if (state === undefined) return
    const before = state.groupOf.get(id)
    const after = row === undefined ? null : state.rule.groupKey(row)
    const touched = new Set<string>()
    if (before !== undefined) {
      const group = state.groups.get(before)
      group?.delete(id)
      if (group?.size === 0) state.groups.delete(before)
      state.groupOf.delete(id)
      touched.add(before)
    }
    if (row !== undefined && after !== null) {
      let group = state.groups.get(after)
      if (group === undefined) {
        group = new Map()
        state.groups.set(after, group)
      }
      group.set(id, pick(row, state.fields))
      state.groupOf.set(id, after)
      touched.add(after)
    }
    const flipped = new Set<string>()
    if (before !== (after ?? undefined) && state.orderKeys.delete(id)) collapseVersion++
    if (after === null && state.collapsed.delete(id)) flipped.add(id)
    for (const key of touched) {
      const group = state.groups.get(key)
      const members: CollapseMember[] = group === undefined ? [] : [...group].map(([member, fields]) => ({ id: member, row: fields }))
      const losers = new Set(collapseLosers(state.rule, members))
      const first = state.rule.order === 'first-member' && losers.size ? members.map(member => member.id).sort()[0] : undefined
      for (const member of members) {
        const previous = state.orderKeys.get(member.id)
        if (first !== undefined && !losers.has(member.id) && member.id !== first) state.orderKeys.set(member.id, first)
        else state.orderKeys.delete(member.id)
        if (previous !== state.orderKeys.get(member.id)) collapseVersion++
        const was = state.collapsed.has(member.id)
        const is = losers.has(member.id)
        if (was === is) continue
        if (is) state.collapsed.add(member.id)
        else state.collapsed.delete(member.id)
        flipped.add(member.id)
      }
    }
    for (const member of flipped) {
      if (member === id) continue
      for (const lane of laneStates) if (lane.lane.member === entity) reseat(lane, member)
    }
    if (flipped.size) collapseVersion++
  }

  // ------------------------------------------------------------- members

  function setMember(entity: EntityName, id: string, row: Row | undefined): void {
    const key = `${entity}:${id}`
    const before = memberOf.get(key)
    const keeper = row === undefined ? null : keeperOf(schema, entity, row)
    if (before !== undefined) {
      const keeps = byOwner.get(before.source)?.get(before.owner)
      keeps?.delete(id)
      if (keeps?.size === 0) byOwner.get(before.source)?.delete(before.owner)
      memberOf.delete(key)
    }
    if (keeper !== null) {
      let owners = byOwner.get(keeper.source)
      if (owners === undefined) {
        owners = new Map()
        byOwner.set(keeper.source, owners)
      }
      let keeps = owners.get(keeper.id)
      if (keeps === undefined) {
        keeps = new Map()
        owners.set(keeper.id, keeps)
      }
      keeps.set(id, keeper.keep)
      memberOf.set(key, { source: keeper.source, owner: keeper.id })
    }
    if (before !== undefined) refile(ownerEntity(before.source), before.owner)
    if (keeper !== null && (before === undefined || before.owner !== keeper.id)) refile(keeper.to, keeper.id)
  }

  const ownerOfSource = new Map<KeptBySpec, EntityName>()
  for (const entity of entities) {
    const spec = schema[entity].cold
    if (spec.kind === 'unlessShown') for (const source of spec.keptBy) ownerOfSource.set(source, entity)
  }
  function ownerEntity(source: KeptBySpec): EntityName {
    return ownerOfSource.get(source)!
  }

  // ------------------------------------------------------------- via

  function setVia(entity: EntityName, id: string, row: Row | undefined, previous: Row | undefined): void {
    const index = byTarget.get(entity)
    if (index === undefined) return
    const before = previous === undefined ? null : viaTargetOf(schema, entity, previous)
    const after = row === undefined ? null : viaTargetOf(schema, entity, row)
    if (before !== null && before.id !== after?.id) {
      const ids = index.get(before.id)
      ids?.delete(id)
      if (ids?.size === 0) index.delete(before.id)
    }
    if (after !== null) {
      let ids = index.get(after.id)
      if (ids === undefined) {
        ids = new Set()
        index.set(after.id, ids)
      }
      ids.add(id)
    }
    refileUnbound(entity, id, row)
  }

  // ------------------------------------------------------------- apply

  function ingest(record: RowRecord): void {
    const entity = record.kind as EntityName
    const row = record.value as Row | undefined
    const roots = plain.get(entity)
    if (roots !== undefined) {
      const had = roots.has(record.id)
      if (row === undefined) roots.delete(record.id)
      else roots.add(record.id)
      for (const state of laneStates) {
        if (state.lane.prefix.to !== entity) continue
        if (had && row === undefined) removeRoot(state, record.id)
        if (!had && row !== undefined) addRoot(state, record.id)
      }
    }
    const held = rules.get(entity)
    const previous = held?.get(record.id)
    if (held !== undefined) {
      if (row === undefined) held.delete(record.id)
      else held.set(record.id, pick(row, fieldsOf.get(entity)!))
    }
    for (const state of laneStates) {
      setExtraRoot(state, entity, record.id, row)
      if (state.lane.owner === entity) setLaneOwner(state, record.id, row)
    }
    setCollapse(entity, record.id, row)
    for (const state of laneStates) if (state.lane.member === entity) setLaneMember(state, record.id, row)
    setMember(entity, record.id, row)
    setVia(entity, record.id, row, previous)
    refile(entity, record.id)
  }

  function clear(): void {
    collapseVersion++
    for (const map of rules.values()) map.clear()
    for (const set of plain.values()) set.clear()
    byOwner.clear()
    memberOf.clear()
    for (const state of laneStates) {
      state.roots.clear()
      state.extraOf.clear()
      state.members.clear()
      state.under.clear()
      state.seat.clear()
      state.keeps.clear()
      laneOwners.get(state)!.clear()
      laneKeyOf.get(state)!.clear()
    }
    for (const state of collapses.values()) {
      state.groups.clear()
      state.groupOf.clear()
      state.collapsed.clear()
      state.orderKeys.clear()
    }
    for (const map of byTarget.values()) map.clear()
    for (const set of open.values()) set.clear()
    for (const map of alive.values()) map.clear()
    for (const map of unboundAlive.values()) map.clear()
    high = Number.NEGATIVE_INFINITY
  }

  // ------------------------------------------------------------- queries

  /** Raise the expiry clock; a rewind below it re-files every held row once. */
  function advance(now: number): void {
    if (now >= high) {
      high = now
      return
    }
    high = now
    for (const entity of entities) {
      for (const [id, row] of rules.get(entity)!) {
        refile(entity, id)
        refileUnbound(entity, id, row)
      }
    }
  }

  function candidates(entity: EntityName, now: number, ctx: ColdContext): string[] {
    const spec = schema[entity].cold
    const held = rules.get(entity)
    if (held === undefined) return []
    const out: string[] = []
    const keep = (id: string): void => {
      const row = held.get(id)
      if (row !== undefined && !ctx.coldTarget(entity, id)) out.push(id)
    }
    if (spec.kind === 'own' || spec.kind === 'unlessShown') {
      for (const id of open.get(entity)!) out.push(id)
      const aliveMap = alive.get(entity)!
      for (const [id, until] of aliveMap) {
        if (until < now) aliveMap.delete(id)
        else keep(id)
      }
      return out
    }
    if (spec.kind !== 'via') return []
    const relation = schema[entity].relations[spec.relation]
    if (relation?.kind !== 'belongsTo') return []
    const index = byTarget.get(entity)!
    const targets = rules.get(relation.to)
    // Bound rows: their target is resident, or unknown (a missing target is never cold).
    const residentTargets = new Set(candidates(relation.to, now, ctx))
    for (const [target, ids] of index) {
      if (targets?.has(target) && !residentTargets.has(target)) continue
      for (const id of ids) out.push(id)
    }
    const unbound = unboundAlive.get(entity)!
    for (const [id, until] of unbound) {
      if (until < now) unbound.delete(id)
      else keep(id)
    }
    return out
  }

  return {
    get readerVersion() { return readers.version + collapseVersion },
    readerRevision: question => readers.revision(question),
    get issueRepoRevision() { return readers.repoRevision },
    get sessionRevision() { return collapseVersion },
    readerIds: question => readers.ids(question),
    issueRepoIds: () => readers.repoIds(),
    sessionCollapsed: id => collapses.get('session')?.collapsed.has(id) ?? false,
    sessionOrderKey: id => collapses.get('session')?.orderKeys.get(id) ?? id,
    get version() {
      return version
    },
    known(entity, id) {
      return rules.get(entity)?.has(id) ?? plain.get(entity)?.has(id) ?? false
    },
    count(entity) {
      return rules.get(entity)?.size ?? plain.get(entity)?.size ?? 0
    },
    coldByRule(entity, id, now) {
      const row = rules.get(entity)?.get(id)
      return row !== undefined && coldByRule(schema, entity, row, context(now))
    },
    residentCandidates(entity, now) {
      advance(now)
      return candidates(entity, now, context(now))
    },
    apply(event) {
      version += 1
      if (event.type === 'replace') clear()
      for (const record of event.rows) ingest(record)
      readers.apply(event)
    },
  }
}
