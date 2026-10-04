/**
 * POD-4748 — a census of the MobX tracking objects code builds, taken from
 * OUTSIDE that code.
 *
 * Nothing here asks the code under test what it built. MobX's own classes are
 * trapped instead: every MobX class assigns its fields in its constructor
 * (`this.name_ = void 0`, …), so an accessor on the class prototype for one
 * such field sees each instance exactly once, as it is constructed, and then
 * steps aside (it defines the instance's own data property, so every later
 * write is a plain write). The traps are installed by `startCensus` and
 * removed by `stop`; instances built outside a census are never seen.
 *
 * Kinds counted, one trap each: computed values (`ComputedValue`), reactions
 * (`Reaction`: `autorun`, `reaction`, `when` and `observer` renders all build
 * one), observable values (`ObservableValue`: object properties, boxes, map
 * entries and a map's `has()` probes), bare atoms (`createAtom`, and the
 * key/change atoms inside collections), maps, sets, arrays (their
 * administration) and observable objects (their administration).
 *
 * Work, counted per phase: computed bodies run (`computeValue_`), reaction
 * bodies run (`Reaction.track`), and changes reported (`Atom.reportChanged`,
 * which every observable write goes through). A caller may add its own
 * counters through `sample` (the read fence's row reads, say).
 *
 * PHASES are the caller's: `enter(label)` / `exit()` keep a stack, and every
 * object and every run is charged to the label on top. `relabel` renames the
 * top frame (a bootstrap whose tail, after its last nested call, is a
 * different phase).
 *
 * THE SNAPSHOT (`snapshot()`) classifies what was built so far from MobX's
 * graph, not from names:
 * - a computed is DECLARED when it has a scope (`makeObservable`'s target),
 *   else standalone; its OWNER is that target;
 * - an observable value is an object PROPERTY (owner: the object), a map
 *   ENTRY, a map HAS probe, or STANDALONE (a box, or one its container has
 *   since dropped);
 * - a reaction's owner is the single owner of everything it observes, when
 *   there is one (a node's maintenance reaction observes that node's
 *   computeds only);
 * - a reaction is LIVE until disposed.
 * An owner is described by its class name and its `id` field, when it has a
 * string one. Owners are compared by identity: two models of one issue are
 * two owners.
 *
 * Internals read: `ComputedValue.scope_`, `Reaction.observing_` /
 * `isDisposed`, `ObservableMap.data_` / `hasMap_`, `ObservableSet.data_`,
 * array `values_`, object `target_` / `values_`. Pinned to the MobX this
 * package installs; the census test fails loudly if a trap sees nothing.
 */

import {
  $mobx,
  computed,
  createAtom,
  ObservableMap,
  ObservableSet,
  observable,
  Reaction,
} from 'mobx'
import { enableDebugNames } from '@podium/client-graph/debug-name'

export type CensusKind =
  | 'computed'
  | 'reaction'
  | 'observableValue'
  | 'atom'
  | 'map'
  | 'set'
  | 'array'
  | 'object'

export const CENSUS_KINDS: readonly CensusKind[] = [
  'computed',
  'reaction',
  'observableValue',
  'atom',
  'map',
  'set',
  'array',
  'object',
]

/** The phase charged before any `enter`. */
export const OUTSIDE_PHASES = '(no phase)'

/** Work one phase did. */
export interface PhaseWork {
  /** Objects built, per kind. */
  built: Record<CensusKind, number>
  /** Computed bodies run. */
  computedRuns: number
  /** Reaction bodies run (tracked). */
  reactionRuns: number
  /** Changes reported by observables (every observable write). */
  changes: number
  /** The caller's `sample` counters, summed over the phase's segments. */
  sampled: Record<string, number>
}

/** Who holds a tracking object: the object a computed or property is declared on. */
export interface Owner {
  readonly cls: string
  readonly id: string | null
}

export interface CensusEntry {
  readonly kind: CensusKind
  /** The phase that built it. */
  readonly phase: string
  /**
   * computed: 'declared' | 'standalone'; observableValue: 'property' |
   * 'mapEntry' | 'mapHas' | 'standalone'; reaction: 'live' | 'disposed';
   * others: the kind.
   */
  readonly sub: string
  readonly owner: Owner | null
  /** Container attribution for the history probe; read from the same objects as held totals.
   * A reaction's debug name (no size). */
  readonly name?: string
  readonly size?: number
}

export interface CensusSnapshot {
  readonly entries: readonly CensusEntry[]
  /** Entries currently held by the built containers. */
  readonly held: { mapEntries: number; setMembers: number; arrayElements: number }
  readonly phases: Readonly<Record<string, PhaseWork>>
}

export interface Census {
  enter(label: string): void
  exit(): void
  relabel(label: string): void
  /** The label charged now. */
  readonly phase: string
  snapshot(): CensusSnapshot
  /** Remove every trap and patch. Idempotent. */
  stop(): void
}

interface Internal {
  name_?: string
  scope_?: unknown
  observing_?: readonly unknown[]
  isDisposed?: boolean
  data_?: Map<unknown, unknown> | Set<unknown>
  hasMap_?: Map<unknown, unknown>
  values_?: Map<unknown, unknown> | readonly unknown[]
  target_?: unknown
}

/** One prototype per kind and the constructor-assigned field trapped on it. */
function trapSites(): { kind: CensusKind; proto: object; field: string }[] {
  const box = observable.box(0)
  const array = observable.array<number>([])
  const object = observable({ census: 0 })
  return [
    { kind: 'computed', proto: Object.getPrototypeOf(computed(() => 0)), field: 'name_' },
    { kind: 'reaction', proto: Reaction.prototype, field: 'name_' },
    // Before the atom trap: an ObservableValue's Atom constructor assigns
    // `name_` first, and the nearer prototype's accessor answers it.
    { kind: 'observableValue', proto: Object.getPrototypeOf(box), field: 'name_' },
    { kind: 'atom', proto: Object.getPrototypeOf(createAtom('census')), field: 'name_' },
    { kind: 'map', proto: ObservableMap.prototype, field: 'name_' },
    { kind: 'set', proto: ObservableSet.prototype, field: 'name_' },
    {
      kind: 'array',
      proto: Object.getPrototypeOf((array as unknown as Record<symbol, object>)[$mobx]),
      field: 'owned_',
    },
    {
      kind: 'object',
      proto: Object.getPrototypeOf((object as unknown as Record<symbol, object>)[$mobx]),
      field: 'target_',
    },
  ]
}

function emptyWork(): PhaseWork {
  return {
    built: Object.fromEntries(CENSUS_KINDS.map((kind) => [kind, 0])) as Record<CensusKind, number>,
    computedRuns: 0,
    reactionRuns: 0,
    changes: 0,
    sampled: {},
  }
}

let active: Census | null = null

/**
 * Start a census. `sample`, when given, is called at every phase transition
 * and at `snapshot`, and returns the caller's counters SINCE ITS LAST CALL;
 * they are charged to the phase being left.
 */
export function startCensus(options: { sample?: () => Record<string, number> } = {}): Census {
  if (active !== null) throw new Error('[census] a census is already running')
  enableDebugNames()
  const built: { kind: CensusKind; phase: string; object: object }[] = []
  const phases = new Map<string, PhaseWork>()
  const stack: string[] = [OUTSIDE_PHASES]
  const top = (): string => stack[stack.length - 1]!
  const work = (label: string): PhaseWork => {
    let entry = phases.get(label)
    if (entry === undefined) {
      entry = emptyWork()
      phases.set(label, entry)
    }
    return entry
  }
  const sample = (): void => {
    if (options.sample === undefined) return
    const into = work(top()).sampled
    for (const [key, value] of Object.entries(options.sample())) {
      into[key] = (into[key] ?? 0) + value
    }
  }

  // Every prototype is found before any trap is installed: the probes it
  // builds are not the census's.
  const sites = trapSites()
  const protoOf = (kind: CensusKind): object => {
    const site = sites.find((candidate) => candidate.kind === kind)
    if (site === undefined) throw new Error(`[census] no trap site for ${kind}`)
    return site.proto
  }
  const restores: (() => void)[] = []
  for (const { kind, proto, field } of sites) {
    const before = Object.getOwnPropertyDescriptor(proto, field)
    if (before !== undefined)
      throw new Error(`[census] ${kind}: ${field} is already on the prototype`)
    Object.defineProperty(proto, field, {
      configurable: true,
      get: () => undefined,
      set(this: object, value: unknown) {
        Object.defineProperty(this, field, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        })
        built.push({ kind, phase: top(), object: this })
        work(top()).built[kind] += 1
      },
    })
    restores.push(() => {
      delete (proto as Record<string, unknown>)[field]
    })
  }
  const patch = (proto: object, method: string, count: () => void): void => {
    const host = proto as Record<string, (...args: unknown[]) => unknown>
    const original = host[method]!
    host[method] = function (this: unknown, ...args: unknown[]) {
      count()
      return original.apply(this, args)
    }
    restores.push(() => {
      host[method] = original
    })
  }
  patch(protoOf('computed'), 'computeValue_', () => {
    work(top()).computedRuns += 1
  })
  patch(Reaction.prototype, 'track', () => {
    work(top()).reactionRuns += 1
  })
  patch(protoOf('atom'), 'reportChanged', () => {
    work(top()).changes += 1
  })
  // The sample baseline: nothing before the census is charged.
  options.sample?.()

  let stopped = false
  const census: Census = {
    enter(label) {
      sample()
      stack.push(label)
    },
    exit() {
      if (stack.length === 1) throw new Error('[census] exit without enter')
      sample()
      stack.pop()
    },
    relabel(label) {
      sample()
      stack[stack.length - 1] = label
    },
    get phase() {
      return top()
    },
    snapshot() {
      sample()
      return classify(built, phases)
    },
    stop() {
      if (stopped) return
      stopped = true
      for (const restore of restores.reverse()) restore()
      active = null
    },
  }
  active = census
  return census
}

function ownerOf(object: unknown): Owner | null {
  if (typeof object !== 'object' || object === null) return null
  const id = (object as { id?: unknown }).id
  return { cls: object.constructor?.name ?? 'Object', id: typeof id === 'string' ? id : null }
}

function classify(
  built: readonly { kind: CensusKind; phase: string; object: object }[],
  phases: ReadonlyMap<string, PhaseWork>,
): CensusSnapshot {
  // Containers first: which observable values they hold, and whose.
  const valueRole = new Map<object, { sub: string; owner: object | null }>()
  const held = { mapEntries: 0, setMembers: 0, arrayElements: 0 }
  for (const { kind, object } of built) {
    const internal = object as Internal
    if (kind === 'map') {
      const data = internal.data_ as Map<unknown, object>
      held.mapEntries += data.size
      for (const value of data.values()) valueRole.set(value, { sub: 'mapEntry', owner: null })
      for (const value of (internal.hasMap_ as Map<unknown, object>).values()) {
        valueRole.set(value, { sub: 'mapHas', owner: null })
      }
    } else if (kind === 'set') {
      held.setMembers += (internal.data_ as Set<unknown>).size
    } else if (kind === 'array') {
      held.arrayElements += (internal.values_ as readonly unknown[]).length
    } else if (kind === 'object') {
      const target = internal.target_ as object
      for (const value of (internal.values_ as Map<unknown, object>).values()) {
        if (!valueRole.has(value)) valueRole.set(value, { sub: 'property', owner: target })
      }
    }
  }
  // The owner object of each observable a reaction may observe.
  const ownerObject = new Map<object, object>()
  for (const { kind, object } of built) {
    if (kind === 'computed') {
      const scope = (object as Internal).scope_
      if (typeof scope === 'object' && scope !== null) ownerObject.set(object, scope)
    } else if (kind === 'observableValue') {
      const owner = valueRole.get(object)?.owner
      if (owner != null) ownerObject.set(object, owner)
    }
  }
  const described = new Map<object, Owner | null>()
  const describe = (object: object | undefined): Owner | null => {
    if (object === undefined) return null
    let owner = described.get(object)
    if (owner === undefined) {
      owner = ownerOf(object)
      described.set(object, owner)
    }
    return owner
  }

  const entries: CensusEntry[] = []
  for (const { kind, phase, object } of built) {
    const internal = object as Internal
    if (kind === 'computed') {
      const scope = ownerObject.get(object)
      entries.push({
        kind,
        phase,
        sub: scope === undefined ? 'standalone' : 'declared',
        owner: describe(scope),
      })
    } else if (kind === 'observableValue') {
      const role = valueRole.get(object)
      entries.push({
        kind,
        phase,
        sub: role?.sub ?? 'standalone',
        owner: describe(role?.owner ?? undefined),
      })
    } else if (kind === 'reaction') {
      let single: object | undefined
      let shared = false
      for (const observed of internal.observing_ ?? []) {
        const owner = ownerObject.get(observed as object)
        if (owner === undefined) continue
        if (single === undefined) single = owner
        else if (single !== owner) shared = true
      }
      entries.push({
        kind,
        phase,
        sub: internal.isDisposed === true ? 'disposed' : 'live',
        owner: shared ? null : describe(single),
        ...(internal.name_ === undefined ? {} : { name: internal.name_ }),
      })
    } else {
      const size = kind === 'map' || kind === 'set' ? internal.data_?.size :
        kind === 'array' ? (internal.values_ as readonly unknown[]).length : undefined
      entries.push({ kind, phase, sub: kind, owner: null,
        ...(size === undefined ? {} : { name: internal.name_ ?? '(unnamed)', size }),
      })
    }
  }
  const copy: Record<string, PhaseWork> = {}
  for (const [label, value] of phases) {
    copy[label] = { ...value, built: { ...value.built }, sampled: { ...value.sampled } }
  }
  return { entries, held, phases: copy }
}

/** Wrap `proto[method]` so each call runs as phase `label` (restored by the returned function). */
export function phaseMethod(
  census: Census,
  proto: object,
  method: string,
  label: string,
  after?: () => void,
): () => void {
  const host = proto as Record<string, (...args: unknown[]) => unknown>
  const original = host[method]
  if (typeof original !== 'function') throw new Error(`[census] no method ${method} to wrap`)
  host[method] = function (this: unknown, ...args: unknown[]) {
    census.enter(label)
    try {
      return original.apply(this, args)
    } finally {
      census.exit()
      after?.()
    }
  }
  return () => {
    host[method] = original
  }
}
