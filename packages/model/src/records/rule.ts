/**
 * A COLLECTION RULE IS DATA (POD-7084, design POD-7059 "One shared
 * declaration").
 *
 * The server answers a rule with SQL (`@podium/sync`'s `ruleSql`) and the
 * client with JavaScript ({@link matchesWhere}), so a rule is a plain object
 * both can read, never a function. One rule reads only the record's own saved
 * fields, the clock and the arguments of its instance.
 *
 * The allowed tests, and nothing else:
 *
 * | Test            | Written as                         |
 * |-----------------|------------------------------------|
 * | equals          | `value` or `{ eq: value }`         |
 * | one of          | `{ in: [a, b] }`                   |
 * | is empty        | `{ empty: true }`                  |
 * | the negations   | `{ not: <equals, one of, is empty> }` |
 * | newer than days | `{ newerThan: { days: 7 } }`       |
 * | descendants of  | `{ descendantsOf: id }`            |
 *
 * A clause tests several fields and matches when every test does. A `where`
 * is one clause, or a list of clauses that matches when any one does (the
 * "asking" sessions: an open offer, or an agent that waits for the user).
 *
 * A value inside a test (`{ eq: … }`, `{ in: … }`, the days, the root) may be
 * a {@link ruleParam}, filled by the instance ("the tree under X") or the
 * policy ("recent: N days"); a bare param is not a test. `undefined` and `null` are the same value
 * here: the wire drops absent fields, the database stores NULL.
 *
 * `descendantsOf` is written on the record's parent link (`parentId`) and
 * holds for the given record itself and for every record whose parent chain
 * reaches it: "the tree under X" is `{ parentId: { descendantsOf: X } }`, X
 * included.
 *
 * A field may be a dotted path into a saved object field
 * (`agentState.phase`); the rule then reads that saved field.
 */

export type Scalar = string | number | boolean | null

/** A value filled in by the instance or the policy. */
export interface Param {
  readonly param: string
}

export const ruleParam = (name: string): Param => ({ param: name })

export const isParam = (value: unknown): value is Param =>
  typeof value === 'object' && value !== null && typeof (value as Param).param === 'string'

export type RuleValue = Scalar | Param

export interface EqTest {
  readonly eq: RuleValue
}
export interface InTest {
  readonly in: readonly Scalar[] | Param
}
export interface EmptyTest {
  readonly empty: true
}
export type NegatableTest = Scalar | EqTest | InTest | EmptyTest
export interface NotTest {
  readonly not: NegatableTest
}
export interface NewerThanTest {
  readonly newerThan: { readonly days: number | Param }
}
export interface DescendantsOfTest {
  readonly descendantsOf: RuleValue
}

export type FieldTest = NegatableTest | NotTest | NewerThanTest | DescendantsOfTest

/** Every test must hold. Keys are field names or dotted paths into one. */
export type Clause = Readonly<Record<string, FieldTest>>

/** One clause, or a list of which any one must hold. */
export type Where = Clause | readonly Clause[]

/** The arguments of one instance, and the policy's numbers. */
export type RuleArgs = Readonly<Record<string, Scalar | readonly Scalar[]>>

export const clausesOf = (where: Where): readonly Clause[] =>
  Array.isArray(where) ? (where as readonly Clause[]) : [where as Clause]

/** The saved field a clause key reads: the part before the first dot. */
export const fieldOfPath = (path: string): string => path.split('.')[0]!

export type TestKind = 'eq' | 'in' | 'empty' | 'not' | 'newerThan' | 'descendantsOf'

/** The test's kind; throws on anything outside the allowed set. */
export function testKind(test: FieldTest): TestKind {
  if (test === null || typeof test !== 'object') return 'eq'
  const keys = Object.keys(test)
  if (keys.length !== 1) throw new RuleError(`a test has exactly one key: ${JSON.stringify(test)}`)
  const key = keys[0]!
  switch (key) {
    case 'eq':
    case 'in':
    case 'empty':
    case 'newerThan':
    case 'descendantsOf':
      return key
    case 'not': {
      const inner = (test as NotTest).not
      const kind = testKind(inner as FieldTest)
      if (kind !== 'eq' && kind !== 'in' && kind !== 'empty') {
        throw new RuleError(
          `only equals, one of and is empty may be negated: ${JSON.stringify(test)}`,
        )
      }
      return 'not'
    }
    default:
      throw new RuleError(`not an allowed test: ${JSON.stringify(test)}`)
  }
}

export class RuleError extends Error {}

/** Every clause key a rule reads, in order, once each. */
export function pathsRead(where: Where): string[] {
  const out = new Set<string>()
  for (const clause of clausesOf(where)) for (const path of Object.keys(clause)) out.add(path)
  return [...out]
}

/** Every saved field a rule reads. */
export const fieldsRead = (where: Where): string[] => [
  ...new Set(pathsRead(where).map(fieldOfPath)),
]

/** Every param a rule names. */
export function paramsRead(where: Where): string[] {
  const out = new Set<string>()
  const visit = (value: unknown): void => {
    if (isParam(value)) out.add(value.param)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit)
  }
  for (const clause of clausesOf(where)) visit(clause)
  return [...out]
}

/** Both rules: every pair of their clauses, merged. Throws when both test one field. */
export function andWhere(a: Where | undefined, b: Where | undefined): Where | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const out: Clause[] = []
  for (const left of clausesOf(a)) {
    for (const right of clausesOf(b)) {
      for (const key of Object.keys(right)) {
        if (key in left) throw new RuleError(`both rules test ${key}; write them as one`)
      }
      out.push({ ...left, ...right })
    }
  }
  return out.length === 1 ? out[0]! : out
}

/** Throws unless every test of the rule is an allowed one. */
export function assertWhere(where: Where): void {
  const clauses = clausesOf(where)
  if (clauses.length === 0) throw new RuleError('a where with no clause matches nothing; omit it')
  for (const clause of clauses) {
    for (const [path, test] of Object.entries(clause)) {
      const kind = testKind(test)
      if (kind === 'descendantsOf' && path.includes('.')) {
        throw new RuleError(`descendantsOf reads a parent link, not a path: ${path}`)
      }
    }
  }
}

const DAY_MS = 86_400_000

/** The last cutoff per number of days: every record tested at one `now` compares against the same one. */
const cutoffs = new Map<number, { readonly now: number; readonly cutoff: string }>()

/** The cutoff a `newerThan` test compares against: a time saved after it is newer. */
export function newerThanCutoff(now: number, days: number): string {
  // POD-7119: formatting a date per test was most of a feed change's rule cost.
  const last = cutoffs.get(days)
  if (last !== undefined && last.now === now) return last.cutoff
  const cutoff = new Date(now - days * DAY_MS).toISOString()
  if (cutoffs.size > 16) cutoffs.clear()
  cutoffs.set(days, { now, cutoff })
  return cutoff
}

export function resolveValue(value: RuleValue, args: RuleArgs): Scalar {
  if (!isParam(value)) return value
  const got = args[value.param]
  if (got === undefined) throw new RuleError(`missing rule argument ${value.param}`)
  if (Array.isArray(got))
    throw new RuleError(`rule argument ${value.param} is a list where one value is needed`)
  return got as Scalar
}

export function resolveList(value: readonly Scalar[] | Param, args: RuleArgs): readonly Scalar[] {
  if (!isParam(value)) return value
  const got = args[value.param]
  if (got === undefined) throw new RuleError(`missing rule argument ${value.param}`)
  return Array.isArray(got) ? (got as readonly Scalar[]) : [got as Scalar]
}

export function resolveDays(days: number | Param, args: RuleArgs): number {
  const value = typeof days === 'number' ? days : resolveValue(days, args)
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RuleError(`newerThan needs a number of days, got ${JSON.stringify(value)}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// The JavaScript evaluator
// ---------------------------------------------------------------------------

/** What a JavaScript match needs beyond the record. */
export interface MatchContext {
  /** The clock (epoch ms) `newerThan` compares against. */
  readonly now: number
  readonly args?: RuleArgs
  /** The parent of a record of the same kind, by its parent link; `undefined` when not known. */
  readonly parentOf?: (id: string) => string | null | undefined
  /** The record's own id, for `descendantsOf` (the record itself counts); `record.id` when absent. */
  readonly idOf?: (record: Readonly<Record<string, unknown>>) => string | undefined
}

const normal = (value: unknown): unknown => (value === undefined ? null : value)

function readPath(record: Readonly<Record<string, unknown>>, path: string): unknown {
  let at: unknown = record
  for (const part of path.split('.')) {
    if (at === null || typeof at !== 'object') return null
    at = (at as Record<string, unknown>)[part]
  }
  return normal(at)
}

const isEmpty = (value: unknown): boolean => value === null || value === ''

function negatable(test: NegatableTest, value: unknown, args: RuleArgs): boolean {
  if (test === null || typeof test !== 'object') return value === test
  if ('eq' in test) return value === resolveValue(test.eq, args)
  if ('in' in test) return resolveList(test.in, args).some((item) => value === item)
  return isEmpty(value)
}

/** The record is `root` itself, or its parent chain (from `start`, its parent) reaches `root`. */
function descendantOf(self: unknown, start: unknown, root: Scalar, ctx: MatchContext): boolean {
  if (root === null) return false
  if (self === root) return true
  const seen = new Set<string>()
  let at = start
  while (typeof at === 'string' && at !== '' && !seen.has(at)) {
    if (at === root) return true
    seen.add(at)
    at = normal(ctx.parentOf?.(at))
  }
  return false
}

function testHolds(
  test: FieldTest,
  value: unknown,
  record: Readonly<Record<string, unknown>>,
  ctx: MatchContext,
): boolean {
  const args = ctx.args ?? {}
  switch (testKind(test)) {
    case 'eq':
    case 'in':
    case 'empty':
      return negatable(test as NegatableTest, value, args)
    case 'not':
      return !negatable((test as NotTest).not, value, args)
    case 'newerThan': {
      if (typeof value !== 'string' || value === '') return false
      const days = resolveDays((test as NewerThanTest).newerThan.days, args)
      return value > newerThanCutoff(ctx.now, days)
    }
    case 'descendantsOf':
      return descendantOf(
        ctx.idOf ? ctx.idOf(record) : record['id'],
        value,
        resolveValue((test as DescendantsOfTest).descendantsOf, args),
        ctx,
      )
  }
}

/** Whether `record` (a wire record) matches `where`. */
export function matchesWhere(
  where: Where,
  record: Readonly<Record<string, unknown>>,
  ctx: MatchContext,
): boolean {
  return clausesOf(where).some((clause) =>
    Object.entries(clause).every(([path, test]) =>
      testHolds(test, readPath(record, path), record, ctx),
    ),
  )
}
