import { machinePathAncestors, machinePathKey, machinePathSeparator } from '@podium/model/browser'
/**
 * POD-5407 — THE RELATION INDEX: every declared relation, over every row the
 * feed carries, held once, outside the pool, in plain maps.
 *
 * WHY. The pool used to maintain its relations itself (`relations.ts`), for
 * hot and cold rows alike, so its attach linked every row the replica held
 * (POD-5391: 99% of the phone's 11k rows are cold). The cold index already
 * kept its own copy of the lane seats and collapse groups for the residency
 * rule (finding 14 of the POD-5417 review: the cold rule's facts mirrored
 * three times). This module is the one copy: the cold index reads its lanes
 * and collapse verdicts from it, and the pool's relation reader is a view of
 * it (`relations.ts`), storing nothing per row.
 *
 * NO RELATION IS NAMED HERE. As in the pool's former engine, every
 * single-valued relation (`belongsTo`, `prefix`, outgoing `edge`) is a LINK
 * paired with the collection its `inverse` names; a link holds the source →
 * target forward, the target → members buckets, a `prefix` link's `under`
 * index and `alsoRoots` union, and each declared subset of its collection.
 * The maintenance is the engine's, step for step (`changed`): collapse, the
 * row's own links, a `prefix` target's roots, the extra roots.
 *
 * ROWS. The index reads a row other than the one being written only for a
 * collapse group's peers and the members a moving root takes. For those
 * entities (those with a `collapse` or a link whose collection declares
 * subsets) it keeps the fields it reads, picked from the row the feed handed
 * it; it keeps no other row data. A lane row (`worktree`) is known by its id.
 *
 * DELTAS. Bucket moves are netted per publication and applied once
 * (`flush`), so a cancelled move touches nothing. Each publication leaves a
 * {@link RelationDelta}: the forward slots, buckets and subsets it moved, and
 * the collapse verdicts and order keys that changed. A view (the pool)
 * reports exactly those; nothing else changed.
 *
 * DECLARED QUESTIONS (POD-4286's cutoff rule): {@link RelationQueries}. A
 * bucket's answer is a read-only set of ids; a later memory cutoff can answer
 * the same questions from storage.
 */

import { relationRef, relationTargets } from './links'
import { isLaneRow } from './repo-from-lane'
import {
  type BelongsToSpec,
  type CollapseSpec,
  collapseLosers,
  type EdgeSpec,
  type EntityName,
  extraRootOf,
  longestPrefixPath,
  type ModelSchema,
  normalizeRootPath,
  type PrefixSpec,
  type RelationSpec,
  type SubsetSpec,
} from './schema'

type Row = Readonly<Record<string, unknown>>

const NONE: ReadonlySet<string> = Object.freeze(new Set<string>())

/** A relation resolved from its own row: `belongsTo`, `prefix`, outgoing `edge`. */
export type LinkSpec = BelongsToSpec | PrefixSpec | (EdgeSpec & { readonly direction: 'out' })

export function isLinkSpec(spec: RelationSpec): spec is LinkSpec {
  return (
    spec.kind === 'belongsTo' ||
    spec.kind === 'prefix' ||
    (spec.kind === 'edge' && spec.direction === 'out')
  )
}

/** The fields a link's answer depends on: a change to any re-resolves it (doc §4.2). */
export function linkInputs(spec: LinkSpec): readonly string[] {
  const own =
    spec.kind === 'belongsTo'
      ? spec.foreignKey
      : spec.kind === 'prefix'
        ? spec.sourceField
        : spec.edgeField
  return [own, ...(spec.where?.fields ?? [])]
}

/**
 * `normalized` and every ancestor at a `/` boundary, longest first: exactly
 * the normalized roots `longestPrefixPath` matches for this probe (a root R
 * matches P when P === R or P starts with `R/`).
 */
export function* ancestorPaths(normalized: string): Generator<string> {
  if (machinePathSeparator(normalized) === '\\') {
    yield* machinePathAncestors(normalized)
    return
  }
  yield normalized
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    if (normalized[i] === '/') yield normalized.slice(0, i)
  }
}

/**
 * The root KEYS that could match `normalized`, longest first: each ancestor
 * path in every spelling that normalizes to it (`a` and `a/`,
 * `normalizeRootPath`).
 */
export function* prefixCandidates(normalized: string): Generator<string> {
  for (const path of ancestorPaths(normalized)) {
    if (normalizeRootPath(path) === path) yield path
    const slashed = `${path}/`
    if (normalizeRootPath(slashed) === path) yield slashed
  }
}

/** The questions the relation index answers. Unordered sets; callers order at view time. */
export interface RelationQueries {
  /** A single-valued link's target key for `from:id` (its raw forward; presence is the caller's). */
  forward(from: EntityName, id: string, relation: string): string | null
  /** A prefix relation's source path, including rows outside its visible membership. */
  prefixPath(from: EntityName, id: string, relation: string): string | null
  /** A many-valued outgoing edge's target keys for `from:id`. */
  targets(from: EntityName, id: string, relation: string): ReadonlySet<string>
  /** A collection's members at `to:id` (`hasMany`, incoming `edge`). */
  members(to: EntityName, id: string, collection: string): ReadonlySet<string>
  /** A collection's declared subset at `to:id` (POD-4758). */
  subset(to: EntityName, id: string, collection: string, subset: string): ReadonlySet<string>
  /** Whether the entity's declared collapse folds `id` away. */
  collapsed(entity: EntityName, id: string): boolean
  /** The declared collapse ordering key of `id` (`first-member`), else `id`. */
  orderKey(entity: EntityName, id: string): string
  /** Whether `key` is a root of a `prefix` onto `to` through `alsoRoots` (the union beyond its table). */
  extraRoot(to: EntityName, key: string): boolean
}

/** What one publication moved. */
export interface RelationDelta {
  /** `${from}.${relation}` and the source whose forward moved. */
  readonly forwards: readonly (readonly [string, string])[]
  /** `${to}.${collection}`, the target, the member, and whether it was added. */
  readonly buckets: readonly (readonly [string, string, string, boolean])[]
  /** `${to}.${collection}.${subset}`, the target, the member, and whether it joined. */
  readonly subsets: readonly (readonly [string, string, string, boolean])[]
  /** Rows whose collapse verdict flipped. */
  readonly flips: readonly (readonly [EntityName, string])[]
  /** Rows whose collapse order key changed. */
  readonly orders: readonly (readonly [EntityName, string])[]
  /** `prefix` link targets (`to`) whose `alsoRoots` presence changed, and the key. */
  readonly roots: readonly (readonly [EntityName, string])[]
}

export interface RelationIndex extends RelationQueries {
  /** Start a publication. */
  begin(): void
  /**
   * One row written (`row`) or gone (`undefined`). `existed`: whether the
   * feed carried the row before this write (the caller knows its rows).
   */
  changed(entity: EntityName, id: string, existed: boolean, row: Row | undefined): void
  /** End the publication: apply the netted moves; what it moved. */
  flush(): RelationDelta
  /** A collection's members, this publication's pending moves included, sorted (maintenance). */
  pendingMembers(to: EntityName, id: string, collection: string): readonly string[]
  /** Forget everything (a `replace`). */
  clear(): void
  /** Per-row entries held, for the heap census: forwards, bucket elements, kept fields. */
  census(): { forwards: number; elements: number; rows: number }
}

interface Link {
  readonly from: EntityName
  readonly name: string
  readonly key: string
  readonly spec: LinkSpec
  /** `${to}.${inverse}`: the collection this link maintains. */
  readonly collection: string
  readonly inputs: readonly string[]
  readonly forward: Map<string, string>
  readonly buckets: Map<string, Set<string>>
  /** `prefix` only: normalized path → members at or under it. */
  readonly under: Map<string, Set<string>> | null
  /** `prefix` only: member → its indexed normalized source path. */
  readonly placed: Map<string, string> | null
  readonly forwardMany: Map<string, ReadonlySet<string>> | null
  /** `prefix` with `alsoRoots` only: raw extra root → rows naming it. */
  readonly extraCounts: Map<string, number> | null
  /** `prefix` with `alsoRoots` only: `${entity}:${id}` → the raw extra root it names. */
  readonly extraByRow: Map<string, string> | null
  readonly subsets: readonly Subset[]
}

interface Subset {
  readonly name: string
  readonly key: string
  readonly spec: SubsetSpec
  readonly sets: Map<string, Set<string>>
}

interface Collapse {
  readonly rule: CollapseSpec
  readonly groups: Map<string, Set<string>>
  readonly groupOf: Map<string, string>
  readonly collapsed: Set<string>
  readonly orderKeys: Map<string, string>
}

export function createRelationIndex(schema: ModelSchema): RelationIndex {
  const entities = Object.keys(schema) as EntityName[]
  const links = new Map<string, Link>()
  const collections = new Map<string, Link>()
  const outgoing = new Map<EntityName, Link[]>(entities.map((entity) => [entity, []]))
  const prefixTargets = new Map<EntityName, Link[]>()
  const extraSources = new Map<EntityName, Link[]>()
  const collapses = new Map<EntityName, Collapse>()
  for (const entity of entities) {
    const rule = schema[entity].collapse
    if (rule !== undefined) {
      collapses.set(entity, {
        rule,
        groups: new Map(),
        groupOf: new Map(),
        collapsed: new Set(),
        orderKeys: new Map(),
      })
    }
  }
  for (const from of entities) {
    for (const [name, spec] of Object.entries(schema[from].relations)) {
      if (!isLinkSpec(spec)) continue
      const prefix = spec.kind === 'prefix'
      const extra = prefix && spec.alsoRoots !== undefined && spec.alsoRoots.length > 0
      const inverse = schema[spec.to].relations[spec.inverse]
      const declared = inverse?.kind === 'hasMany' ? Object.entries(inverse.subsets ?? {}) : []
      const collection = `${spec.to}.${spec.inverse}`
      const link: Link = {
        from,
        name,
        key: `${from}.${name}`,
        spec,
        collection,
        inputs: linkInputs(spec),
        forward: new Map(),
        buckets: new Map(),
        under: prefix ? new Map() : null,
        placed: prefix ? new Map() : null,
        forwardMany: spec.kind === 'edge' && spec.many ? new Map() : null,
        extraCounts: extra ? new Map() : null,
        extraByRow: extra ? new Map() : null,
        subsets: declared.map(([subset, subsetSpec]) => ({
          name: subset,
          key: `${collection}.${subset}`,
          spec: subsetSpec,
          sets: new Map(),
        })),
      }
      links.set(link.key, link)
      collections.set(collection, link)
      outgoing.get(from)?.push(link)
      if (prefix) prefixTargets.set(spec.to, [...(prefixTargets.get(spec.to) ?? []), link])
      if (prefix && spec.alsoRoots !== undefined) {
        for (const source of spec.alsoRoots) {
          extraSources.set(source.entity, [...(extraSources.get(source.entity) ?? []), link])
        }
      }
    }
  }
  for (const from of entities) {
    for (const [name, spec] of Object.entries(schema[from].relations)) {
      if (!isLinkSpec(spec) && !collections.has(`${from}.${name}`)) {
        throw new Error(`[pool] ${from}.${name} is a collection no relation maintains`)
      }
    }
  }
  // The rows read again after their own write: a collapse's peers and flips,
  // a subset's members under a moving root. Only those fields are kept.
  const keptFields = new Map<EntityName, readonly string[]>()
  for (const from of entities) {
    const own = outgoing.get(from) ?? []
    const collapse = schema[from].collapse
    if (collapse === undefined && !own.some((link) => link.subsets.length > 0)) continue
    const fields = new Set(collapse?.fields ?? [])
    for (const link of own) {
      for (const field of link.inputs) fields.add(field)
      for (const subset of link.subsets) for (const field of subset.spec.fields) fields.add(field)
    }
    keptFields.set(from, [...fields])
  }
  const kept = new Map<EntityName, Map<string, Row>>(
    [...keptFields.keys()].map((entity) => [entity, new Map()]),
  )
  /** Rows of a `prefix` target entity (lanes): their keys are the table roots. */
  const roots = new Map<EntityName, Set<string>>(
    [...prefixTargets.keys()].map((entity) => [entity, new Set()]),
  )

  // Per publication.
  const pending = new Map<Link, Map<string, Map<string, boolean>>>()
  let forwards: [string, string][] = []
  let subsetMoves: [string, string, string, boolean][] = []
  let flips = new Map<string, [EntityName, string]>()
  let orders = new Map<string, [EntityName, string]>()
  let rootChanges: [EntityName, string][] = []

  // ------------------------------------------------------------- reads

  function peekForward(link: Link, id: string): string | undefined {
    return link.forward.get(id)
  }

  function rowOf(entity: EntityName, id: string): Row | undefined {
    return kept.get(entity)?.get(id)
  }

  function isCollapsed(entity: EntityName, id: string): boolean {
    return collapses.get(entity)?.collapsed.has(id) ?? false
  }

  function probeRoot(link: Link, normalized: string): string | null {
    const table = roots.get(link.spec.to)
    if (machinePathSeparator(normalized) === '\\') return longestPrefixPath(normalized, [...(table ?? []), ...(link.extraCounts?.keys() ?? [])])
    for (const candidate of prefixCandidates(normalized)) {
      if (table?.has(candidate) === true) return candidate
      if (link.extraCounts?.has(candidate) === true) return candidate
    }
    return null
  }

  function pendingMembers(link: Link, target: string): readonly string[] {
    target = machinePathKey(target)
    const members = new Set(link.buckets.get(target) ?? NONE)
    for (const [member, added] of pending.get(link)?.get(target) ?? []) {
      if (added) members.add(member)
      else members.delete(member)
    }
    return [...members].sort()
  }

  // ------------------------------------------------------------- moves

  function move(link: Link, target: string, member: string, added: boolean): void {
    target = machinePathKey(target)
    let targets = pending.get(link)
    if (targets === undefined) {
      targets = new Map()
      pending.set(link, targets)
    }
    let moves = targets.get(target)
    if (moves === undefined) {
      moves = new Map()
      targets.set(target, moves)
    }
    if (moves.get(member) === !added) moves.delete(member)
    else moves.set(member, added)
  }

  function point(link: Link, id: string, target: string | null): void {
    const old = peekForward(link, id)
    if ((old ?? null) === target) return
    if (old !== undefined) {
      move(link, old, id, false)
      link.forward.delete(id)
    }
    if (target !== null) {
      move(link, target, id, true)
      link.forward.set(id, target)
    }
    forwards.push([link.key, id])
  }

  function fileSubset(subset: Subset, target: string, id: string, row: Row): void {
    target = machinePathKey(target)
    if (!subset.spec.test(row)) {
      dropSubset(subset, target, id)
      return
    }
    let set = subset.sets.get(target)
    if (set === undefined) {
      set = new Set()
      subset.sets.set(target, set)
    }
    if (set.has(id)) return
    set.add(id)
    subsetMoves.push([subset.key, target, id, true])
  }

  function dropSubset(subset: Subset, target: string, id: string): void {
    target = machinePathKey(target)
    const set = subset.sets.get(target)
    if (set === undefined || !set.has(id)) return
    set.delete(id)
    if (set.size === 0) subset.sets.delete(target)
    subsetMoves.push([subset.key, target, id, false])
  }

  function refile(
    link: Link,
    id: string,
    old: string | null,
    target: string | null,
    row: Row | undefined,
  ): void {
    for (const subset of link.subsets) {
      if (old !== null && old !== target) dropSubset(subset, old, id)
      if (target !== null && row !== undefined) fileSubset(subset, target, id, row)
    }
  }

  function place(link: Link, id: string, normalized: string | null): void {
    const under = link.under as Map<string, Set<string>>
    const placed = link.placed as Map<string, string>
    const old = placed.get(id) ?? null
    if (old === normalized) return
    if (old !== null) {
      for (const path of ancestorPaths(old)) {
        const set = under.get(path)
        set?.delete(id)
        if (set?.size === 0) under.delete(path)
      }
      placed.delete(id)
    }
    if (normalized !== null) {
      for (const path of ancestorPaths(normalized)) {
        let set = under.get(path)
        if (set === undefined) {
          set = new Set()
          under.set(path, set)
        }
        set.add(id)
      }
      placed.set(id, normalized)
    }
  }

  function relink(link: Link, id: string, row: Row | undefined): void {
    const member =
      row !== undefined &&
      (link.spec.where === undefined || link.spec.where.test(row)) &&
      (link.spec.uncollapsed === true || !isCollapsed(link.from, id))
    if (link.forwardMany !== null) {
      const previous = link.forwardMany.get(id) ?? NONE
      const targets = member ? relationTargets(link.from, link.name, row, schema) : NONE
      if (previous.size === targets.size && [...previous].every((target) => targets.has(target)))
        return
      for (const target of previous) if (!targets.has(target)) move(link, target, id, false)
      for (const target of targets) if (!previous.has(target)) move(link, target, id, true)
      if (targets.size) link.forwardMany.set(id, targets)
      else link.forwardMany.delete(id)
      forwards.push([link.key, id])
      return
    }
    let target: string | null = null
    if (member && link.spec.kind === 'prefix') {
      const path = row[link.spec.sourceField]
      const normalized = typeof path === 'string' ? normalizeRootPath(path) : null
      place(link, id, normalized)
      target = normalized === null ? null : probeRoot(link, normalized)
    } else {
      if (link.placed !== null) place(link, id, null)
      if (member) target = relationRef(link.from, link.name, row, schema)
    }
    const old = peekForward(link, id) ?? null
    point(link, id, target)
    refile(link, id, old, target, row)
  }

  function rootAdded(link: Link, root: string): void {
    const normalized = normalizeRootPath(root)
    const candidates = link.under?.get(normalized)
    if (candidates === undefined) return
    for (const id of [...candidates]) {
      const current = peekForward(link, id)
      if (current !== undefined && normalizeRootPath(current).length >= normalized.length) continue
      point(link, id, root)
      if (link.subsets.length > 0) refile(link, id, current ?? null, root, rowOf(link.from, id))
    }
  }

  function rootRemoved(link: Link, root: string): void {
    const members = pendingMembers(link, root)
    if (members.length === 0) return
    const next = probeRoot(link, normalizeRootPath(root))
    for (const id of members) {
      point(link, id, next)
      if (link.subsets.length > 0) {
        refile(link, id, root, next, next === null ? undefined : rowOf(link.from, id))
      }
    }
  }

  function extraChanged(link: Link, entity: EntityName, id: string, after: Row | undefined): void {
    const counts = link.extraCounts
    const byRow = link.extraByRow
    const spec = link.spec
    if (counts === null || byRow === null || spec.kind !== 'prefix' || spec.alsoRoots === undefined)
      return
    const key = `${entity}:${id}`
    const oldRaw = byRow.get(key) ?? null
    let newRaw: string | null = null
    if (after !== undefined) {
      for (const source of spec.alsoRoots) {
        if (source.entity !== entity) continue
        const root = extraRootOf(source, after)
        if (root !== null) {
          newRaw = root
          break
        }
      }
    }
    if (oldRaw === newRaw) return
    const table = roots.get(spec.to)
    if (newRaw !== null) {
      byRow.set(key, newRaw)
      const count = (counts.get(newRaw) ?? 0) + 1
      counts.set(newRaw, count)
      if (count === 1) {
        rootChanges.push([spec.to, newRaw])
        if (table?.has(newRaw) !== true) rootAdded(link, newRaw)
      }
    } else byRow.delete(key)
    if (oldRaw !== null) {
      const left = (counts.get(oldRaw) ?? 0) - 1
      if (left <= 0) {
        counts.delete(oldRaw)
        rootChanges.push([spec.to, oldRaw])
        if (table?.has(oldRaw) !== true) rootRemoved(link, oldRaw)
      } else counts.set(oldRaw, left)
    }
  }

  function recollapse(
    entity: EntityName,
    id: string,
    before: Row | undefined,
    after: Row | undefined,
  ): Set<string> {
    const flipped = new Set<string>()
    const collapse = collapses.get(entity)
    if (collapse === undefined) return flipped
    const { rule, groups, groupOf, collapsed, orderKeys } = collapse
    if (before !== undefined && after !== undefined && sameInputs(rule.fields, before, after))
      return flipped
    const oldKey = groupOf.get(id) ?? null
    const newKey = after === undefined ? null : rule.groupKey(after)
    const order = (member: string, key: string | undefined): void => {
      const previous = orderKeys.get(member)
      if (previous === key) return
      if (key === undefined) orderKeys.delete(member)
      else orderKeys.set(member, key)
      orders.set(`${entity}:${member}`, [entity, member])
    }
    if (oldKey !== newKey) {
      order(id, undefined)
      if (oldKey !== null) {
        const group = groups.get(oldKey)
        group?.delete(id)
        if (group?.size === 0) groups.delete(oldKey)
        groupOf.delete(id)
      }
      if (newKey !== null) {
        let group = groups.get(newKey)
        if (group === undefined) {
          group = new Set()
          groups.set(newKey, group)
        }
        group.add(id)
        groupOf.set(id, newKey)
      }
    }
    if (newKey === null && collapsed.has(id)) {
      collapsed.delete(id)
      flipped.add(id)
    }
    for (const key of new Set([oldKey, newKey])) {
      if (key === null) continue
      const group = groups.get(key)
      if (group === undefined) continue
      const members = [...group].map((member) => ({
        id: member,
        row: (member === id ? after : rowOf(entity, member)) as Row,
      }))
      const losers = new Set(collapseLosers(rule, members))
      const first = rule.order === 'first-member' && losers.size ? [...group].sort()[0] : undefined
      for (const { id: member } of members) {
        order(
          member,
          first !== undefined && !losers.has(member) && member !== first ? first : undefined,
        )
        if (losers.has(member) === collapsed.has(member)) continue
        if (losers.has(member)) collapsed.add(member)
        else collapsed.delete(member)
        flipped.add(member)
      }
    }
    for (const member of flipped) flips.set(`${entity}:${member}`, [entity, member])
    return flipped
  }

  function keep(entity: EntityName, id: string, row: Row | undefined): void {
    const fields = keptFields.get(entity)
    const held = kept.get(entity)
    if (fields === undefined || held === undefined) return
    if (row === undefined) {
      held.delete(id)
      return
    }
    const picked: Record<string, unknown> = {}
    for (const field of fields) {
      const value = row[field]
      if (value !== undefined) picked[field] = value
    }
    held.set(id, picked)
  }

  // ------------------------------------------------------------- maintenance

  function changed(entity: EntityName, id: string, existed: boolean, input: Row | undefined): void {
    // A lane-target entity's record without a lane path is not a row of it
    // (the feed's raw repo row, keyed by its repo id).
    const table = roots.get(entity)
    const after =
      table !== undefined && input !== undefined && !isLaneRow(input) ? undefined : input
    const was = table !== undefined ? table.has(id) : existed
    if (table !== undefined && after === undefined && !was) return
    const before = rowOf(entity, id)
    keep(entity, id, after)
    const flipped = recollapse(entity, id, before, after)
    const selfFlipped = flipped.has(id) && flipped.delete(id)
    for (const link of outgoing.get(entity) ?? []) {
      if (after === undefined) {
        relink(link, id, undefined)
        continue
      }
      if (before !== undefined && !selfFlipped && sameInputs(link.inputs, before, after)) continue
      relink(link, id, after)
    }
    for (const other of flipped) {
      const row = rowOf(entity, other)
      for (const link of outgoing.get(entity) ?? []) relink(link, other, row)
    }
    // A field a subset reads moved without moving the member (relink skipped).
    if (before !== undefined && after !== undefined) {
      for (const link of outgoing.get(entity) ?? []) {
        for (const subset of link.subsets) {
          if (sameInputs(subset.spec.fields, before, after)) continue
          const target = peekForward(link, id)
          if (target !== undefined) fileSubset(subset, target, id, after)
        }
      }
    }
    if (table !== undefined && (after !== undefined) !== was) {
      if (after !== undefined) table.add(id)
      else table.delete(id)
      for (const link of prefixTargets.get(entity) ?? []) {
        if (link.extraCounts?.has(id) === true) continue
        if (after !== undefined) rootAdded(link, id)
        else rootRemoved(link, id)
      }
    }
    for (const link of extraSources.get(entity) ?? []) extraChanged(link, entity, id, after)
  }

  function flush(): RelationDelta {
    const buckets: [string, string, string, boolean][] = []
    for (const [link, targets] of pending) {
      for (const [target, moves] of targets) {
        if (moves.size === 0) continue
        let bucket = link.buckets.get(target)
        for (const [member, added] of moves) {
          if (added === (bucket?.has(member) ?? false)) continue
          if (added) {
            if (bucket === undefined) {
              bucket = new Set()
              link.buckets.set(target, bucket)
            }
            bucket.add(member)
          } else bucket?.delete(member)
          buckets.push([link.collection, target, member, added])
        }
        if (bucket?.size === 0) link.buckets.delete(target)
      }
    }
    pending.clear()
    const delta: RelationDelta = {
      forwards,
      buckets,
      subsets: subsetMoves,
      flips: [...flips.values()],
      orders: [...orders.values()],
      roots: rootChanges,
    }
    forwards = []
    subsetMoves = []
    flips = new Map()
    orders = new Map()
    rootChanges = []
    return delta
  }

  function clear(): void {
    for (const link of links.values()) {
      link.forward.clear()
      link.buckets.clear()
      link.forwardMany?.clear()
      link.under?.clear()
      link.placed?.clear()
      link.extraCounts?.clear()
      link.extraByRow?.clear()
      for (const subset of link.subsets) subset.sets.clear()
    }
    for (const collapse of collapses.values()) {
      collapse.groups.clear()
      collapse.groupOf.clear()
      collapse.collapsed.clear()
      collapse.orderKeys.clear()
    }
    for (const held of kept.values()) held.clear()
    for (const table of roots.values()) table.clear()
    pending.clear()
    forwards = []
    subsetMoves = []
    flips = new Map()
    orders = new Map()
    rootChanges = []
  }

  function linkOf(from: EntityName, relation: string): Link {
    const link = links.get(`${from}.${relation}`)
    if (link === undefined) {
      if (schema[from].relations[relation] === undefined) {
        throw new Error(`[pool] ${from}.${relation} is not a declared relation`)
      }
      throw new Error(`[pool] ${from}.${relation} is a collection; read it with members()`)
    }
    return link
  }

  function collectionOf(to: EntityName, collection: string): Link {
    const link = collections.get(`${to}.${collection}`)
    if (link === undefined) {
      if (schema[to].relations[collection] === undefined) {
        throw new Error(`[pool] ${to}.${collection} is not a declared relation`)
      }
      throw new Error(`[pool] ${to}.${collection} is single-valued; read it with forward()`)
    }
    return link
  }

  return {
    prefixPath(from, id, relation) {
      const link = linkOf(from, relation)
      if (link.spec.kind !== 'prefix') throw new Error(`[pool] ${from}.${relation} is not a prefix`)
      const path = rowOf(from, id)?.[link.spec.sourceField]
      return typeof path === 'string' ? normalizeRootPath(path) : link.placed?.get(id) ?? null
    },
    forward(from, id, relation) {
      const link = linkOf(from, relation)
      if (link.forwardMany !== null)
        throw new Error(`[pool] ${from}.${relation} is a collection; read its targets`)
      return link.forward.get(id) ?? null
    },
    targets(from, id, relation) {
      const link = linkOf(from, relation)
      if (link.forwardMany === null) throw new Error(`[pool] ${from}.${relation} is single-valued`)
      return link.forwardMany.get(id) ?? NONE
    },
    members(to, id, collection) {
      return collectionOf(to, collection).buckets.get(machinePathKey(id)) ?? NONE
    },
    subset(to, id, collection, subset) {
      const link = collectionOf(to, collection)
      const found = link.subsets.find((each) => each.name === subset)
      if (found === undefined)
        throw new Error(`[pool] ${link.collection} declares no subset "${subset}"`)
      return found.sets.get(machinePathKey(id)) ?? NONE
    },
    collapsed: isCollapsed,
    orderKey(entity, id) {
      return collapses.get(entity)?.orderKeys.get(id) ?? id
    },
    extraRoot(to, key) {
      for (const link of prefixTargets.get(to) ?? [])
        if (link.extraCounts?.has(key) === true) return true
      return false
    },
    begin() {
      pending.clear()
    },
    changed,
    flush,
    pendingMembers(to, id, collection) {
      return pendingMembers(collectionOf(to, collection), id)
    },
    clear,
    census() {
      let forwardCount = 0
      let elements = 0
      for (const link of links.values()) {
        forwardCount += link.forward.size + (link.forwardMany?.size ?? 0)
        for (const bucket of link.buckets.values()) elements += bucket.size
      }
      let rows = 0
      for (const held of kept.values()) rows += held.size
      return { forwards: forwardCount, elements, rows }
    },
  }
}

function sameInputs(fields: readonly string[], a: Row, b: Row): boolean {
  for (const field of fields) if (a[field] !== b[field]) return false
  return true
}
