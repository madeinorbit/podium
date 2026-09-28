/**
 * A DECLARED STATE MACHINE: the table of allowed moves, written once and shared
 * by every side that stores or reads the status (POD-4765, POD-4720 §5.2/§6.4).
 *
 * Deliberately small and in-house (user decision 2026-09-28: no state-machine
 * library). A persisted lifecycle needs four things and nothing else:
 *
 *  - the allowed values, which feed the zod schema and the database CHECK;
 *  - the allowed moves, as data a reader can diff rather than control flow;
 *  - absorbing terminal states;
 *  - for a guarded write, the set of states a row may be in for a move INTO a
 *    given state to apply (`allowedFrom`), so a store can write one
 *    `UPDATE … WHERE status IN (…)` and let zero rows mean "refused".
 *
 * Staying in the same state is never an edge. A repeated report is answered
 * "already there" by the caller, not applied a second time, which is what makes
 * replays and duplicate reports harmless.
 */

export interface MachineSpec<S extends string> {
  /** Every value the status may hold, in reading order. */
  readonly states: readonly [S, ...S[]]
  /** For each state, the states it may move to. Terminal states list none. */
  readonly edges: { readonly [K in S]: readonly S[] }
  /** Absorbing states: no move leaves them. */
  readonly terminal: readonly S[]
}

export interface StateMachine<S extends string> {
  readonly name: string
  readonly states: readonly [S, ...S[]]
  readonly terminal: readonly S[]
  isState(value: unknown): value is S
  isTerminal(state: S): boolean
  /** The states `from` may move to. */
  next(from: S): readonly S[]
  canMove(from: S, to: S): boolean
  /** Throws {@link IllegalMoveError} unless `from → to` is an allowed move. */
  assertMove(from: S, to: S): void
  /** The states a row may be in for a move into `to` to apply. */
  allowedFrom(to: S): readonly S[]
}

export class IllegalMoveError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${machine}: illegal move ${from} → ${to}`)
    this.name = 'IllegalMoveError'
  }
}

/** Build a machine from its table, refusing a table that contradicts itself. */
export function defineMachine<const S extends string>(
  name: string,
  spec: MachineSpec<S>,
): StateMachine<S> {
  const states = new Set<string>(spec.states)
  if (states.size !== spec.states.length) throw new Error(`${name}: duplicate state`)
  const terminal = new Set<string>(spec.terminal)
  for (const state of terminal) {
    if (!states.has(state)) throw new Error(`${name}: terminal state ${state} is not a state`)
  }
  const edgeKeys = Object.keys(spec.edges)
  for (const key of edgeKeys) {
    if (!states.has(key)) throw new Error(`${name}: edges name unknown state ${key}`)
  }
  const into = new Map<S, S[]>(spec.states.map((state) => [state, []]))
  for (const from of spec.states) {
    const targets = spec.edges[from]
    if (!targets) throw new Error(`${name}: no edge list for ${from}`)
    if (terminal.has(from) && targets.length > 0) {
      throw new Error(`${name}: terminal state ${from} has outgoing moves`)
    }
    if (!terminal.has(from) && targets.length === 0) {
      throw new Error(`${name}: non-terminal state ${from} has no way out`)
    }
    if (new Set(targets).size !== targets.length)
      throw new Error(`${name}: duplicate move from ${from}`)
    for (const to of targets) {
      if (!states.has(to)) throw new Error(`${name}: ${from} moves to unknown state ${to}`)
      if (to === from)
        throw new Error(`${name}: ${from} moves to itself; repeats are "already there"`)
      into.get(to)!.push(from)
    }
  }

  const canMove = (from: S, to: S): boolean => spec.edges[from].includes(to)
  return {
    name,
    states: spec.states,
    terminal: spec.terminal,
    isState: (value: unknown): value is S => typeof value === 'string' && states.has(value),
    isTerminal: (state) => terminal.has(state),
    next: (from) => spec.edges[from],
    canMove,
    assertMove(from, to) {
      if (!canMove(from, to)) throw new IllegalMoveError(name, from, to)
    },
    allowedFrom: (to) => into.get(to) ?? [],
  }
}

/** True when no sequence of moves returns to a state it left: status only
 *  moves forward. Not every machine is one (ship orders loop through `held`);
 *  a forward-only lifecycle asserts it in its own tests. */
export function isForwardOnly<S extends string>(machine: StateMachine<S>): boolean {
  const done = new Set<S>()
  const onPath = new Set<S>()
  const visit = (state: S): boolean => {
    if (onPath.has(state)) return false
    if (done.has(state)) return true
    onPath.add(state)
    for (const next of machine.next(state)) if (!visit(next)) return false
    onPath.delete(state)
    done.add(state)
    return true
  }
  return machine.states.every(visit)
}

/** What a guarded write did. `refused` carries the state the row was actually
 *  in (`null`: no such row), so a caller can report it instead of guessing. */
export type MoveOutcome<S extends string> =
  | { readonly kind: 'applied' }
  | { readonly kind: 'already-there' }
  | { readonly kind: 'refused'; readonly current: S | null }

export interface MoveMismatch<S extends string> {
  readonly from: S
  readonly to: S
  readonly expected: MoveOutcome<S>['kind']
  readonly actual: MoveOutcome<S>['kind']
}

/**
 * THE TABLE WALKER. For every `(from, to)` pair — not only the declared edges —
 * put a fresh row in `from`, try to move it to `to`, and compare the outcome
 * with the table: an edge applies, staying put is "already there", everything
 * else is refused. Returns the pairs that disagreed, so a test asserts `[]`.
 *
 * `attempt` is the implementation under test (typically a real store write), so
 * this proves the guard in the database matches the table, missing edges
 * included.
 */
export async function walkMoves<S extends string>(
  machine: StateMachine<S>,
  attempt: (from: S, to: S) => Promise<MoveOutcome<S>>,
): Promise<MoveMismatch<S>[]> {
  const mismatches: MoveMismatch<S>[] = []
  for (const from of machine.states) {
    for (const to of machine.states) {
      const expected: MoveOutcome<S>['kind'] =
        from === to ? 'already-there' : machine.canMove(from, to) ? 'applied' : 'refused'
      const outcome = await attempt(from, to)
      if (outcome.kind !== expected) mismatches.push({ from, to, expected, actual: outcome.kind })
      else if (outcome.kind === 'refused' && outcome.current !== from) {
        mismatches.push({ from, to, expected, actual: outcome.kind })
      }
    }
  }
  return mismatches
}
