/**
 * THE WORKSPACE SCOPE CHECKER [POD-6959 design 2.5, part 3].
 *
 * Reads one statement's SQL, with the placeholder name behind each bound value, and says
 * whether every workspace table it touches is held to one workspace. The workspace-scope audit
 * (`store/workspace-scope-audit.test.ts`) runs it over every query definition and every planned
 * raw statement; this module knows nothing of the store.
 *
 * WHAT IT READS. A tokeniser (quoted names, strings, comments, both placeholder styles) and a
 * small parser that finds, for each query scope (the statement, each CTE, each derived table,
 * each subquery in an expression), its table references with their aliases and the terms that
 * can constrain them. Expressions themselves are not parsed beyond what that needs: the top-level
 * AND terms of a WHERE or ON, equalities between a column and a placeholder or two columns, and
 * the subqueries inside them.
 *
 * BOTH DIALECTS, because hosted Postgres is the primary target (design section 0):
 *   - SQLite `?` (and `?NNN`, `:name`, `@name`, `$name`) and Postgres `$n` placeholders, each
 *     mapped to its name; on Postgres `?` is a JSON operator;
 *   - `::type` casts (`$1::text`, `$2::jsonb`) and `CAST(x AS type)` around an operand;
 *   - JSON operators (`->`, `->>`, `#>`, `#>>`, `@>`, `?|`, ...), read as operators;
 *   - table-valued functions in FROM (`json_each` on SQLite; `jsonb_array_elements_text`,
 *     `jsonb_each`, `unnest` on Postgres), which are not table references.
 *
 * THE RULES (for a statement of a workspace definition):
 *   - every reference to a workspace table is constrained: some top-level AND term that may
 *     restrict it is `<ref>.workspace_id = <workspaceId placeholder>`, or
 *     `<ref>.workspace_id = <other>.workspace_id` where `<other>` is constrained (in this scope or
 *     an enclosing one: a correlated subquery). A term under OR, or under NOT, does not count. A
 *     LEFT JOIN's ON terms restrict only the joined side;
 *   - an INSERT into a workspace table names `workspace_id`, and takes it from the placeholder or
 *     from a constrained reference of its SELECT;
 *   - no UPDATE or upsert assigns `workspace_id`: that would move a row to another workspace;
 *   - an ON CONFLICT target includes `workspace_id`. This rule exists but is OFF until C1
 *     (POD-7024) turns it on: before the key migration no unique constraint includes the column,
 *     so no target could name it;
 *   - a table the classification does not know is a finding, and SQL the parser cannot read is a
 *     finding (never a pass).
 * A global definition touches no workspace table. A cross-workspace definition is a SELECT that
 * writes nothing; whether it is on the allowlist is the audit's question.
 */

/** Which engine's SQL a statement is; inferred from its placeholders when not given. */
export type ScopeDialect = 'sqlite' | 'postgres'

/** One statement as a definition built it. */
export interface ScopedStatement {
  readonly sql: string
  /**
   * The placeholder name behind each bound value, in binding order (`$n` is entry n-1);
   * undefined for a literal value. A raw statement may instead name its placeholders in the SQL
   * (`:workspaceId`).
   */
  readonly placeholders: readonly (string | undefined)[]
  readonly dialect?: ScopeDialect
}

/** What a definition may touch (`DefinitionScope` in the prepared registry). */
export type CheckedScope = 'workspace' | 'global' | 'across'

/**
 * How the checker sees a table: `workspace` (every row belongs to one workspace), `shared`
 * (classified, and not a workspace table), or undefined (unclassified).
 */
export type TableKind = 'workspace' | 'shared'

export interface ScopeCheckOptions {
  /** Classifies a table by its SQL name (lower case, no schema). */
  readonly tableKind: (table: string) => TableKind | undefined
  /** The ON CONFLICT rule; off until C1 (POD-7024). */
  readonly conflictTargets?: boolean
}

export type ScopeRule =
  | 'unparseable'
  | 'unknown-table'
  | 'unconstrained'
  | 'insert-workspace'
  | 'sets-workspace'
  | 'conflict-target'
  | 'global-workspace-table'
  | 'across-write'

export interface ScopeFinding {
  readonly rule: ScopeRule
  readonly table?: string
  readonly detail: string
}

/** The placeholder every workspace statement names its workspace with (`WORKSPACE`, `inWorkspace`). */
export const WORKSPACE_PLACEHOLDER = 'workspaceId'
const WORKSPACE_COLUMN = 'workspace_id'

/** SQL the checker cannot read. */
export class UnparseableSqlError extends Error {
  override readonly name = 'UnparseableSqlError'
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Token =
  | {
      readonly kind: 'word'
      readonly text: string
      readonly lower: string
      readonly quoted: boolean
    }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'param'; readonly text: string; readonly name: string | undefined }
  | { readonly kind: 'op'; readonly text: string }

const OPERATORS = [
  '->>',
  '#>>',
  '!~*',
  '->',
  '#>',
  '::',
  '||',
  '<=',
  '>=',
  '<>',
  '!=',
  '==',
  '<<',
  '>>',
  '@>',
  '<@',
  '&&',
  '#-',
  '~*',
  '!~',
]
const SINGLE_OPERATORS = new Set('()[],.;=<>+-*/%&|~!@#^:?')

const isWordStart = (ch: string): boolean => /[A-Za-z_\u0080-￿]/.test(ch)
const isWordPart = (ch: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(ch)

/** Infer the dialect: a `$n` placeholder outside strings and quoted names means Postgres. */
function inferDialect(sql: string): ScopeDialect {
  const bare = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`/g, '')
  return /\$\d/.test(bare) ? 'postgres' : 'sqlite'
}

function tokenize(
  sql: string,
  placeholders: readonly (string | undefined)[],
  dialect: ScopeDialect,
): Token[] {
  const tokens: Token[] = []
  let sequential = 0
  let i = 0
  const fail = (what: string): never => {
    throw new UnparseableSqlError(`${what} at offset ${i}: ${sql.slice(i, i + 40)}`)
  }
  const quoted = (close: string, from: number): [string, number] => {
    let text = ''
    let j = from
    for (;;) {
      if (j >= sql.length) fail(`unterminated ${close}`)
      const ch = sql[j]!
      if (ch === close) {
        if (sql[j + 1] === close) {
          text += close
          j += 2
          continue
        }
        return [text, j + 1]
      }
      text += ch
      j += 1
    }
  }
  const param = (text: string, index: number | undefined, name?: string) => {
    tokens.push({
      kind: 'param',
      text,
      name: name ?? (index === undefined ? undefined : placeholders[index]),
    })
  }
  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1] ?? ''
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end + 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) fail('unterminated comment')
      i = end + 2
      continue
    }
    if (ch === "'") {
      const [text, end] = quoted("'", i + 1)
      tokens.push({ kind: 'string', text })
      i = end
      continue
    }
    // A string with a one-letter prefix: X'..' (blob), E'..' (escapes), B'..', N'..'.
    if (/[xXeEbBnN]/.test(ch) && next === "'") {
      let j = i + 2
      let text = ''
      for (;;) {
        if (j >= sql.length) fail('unterminated string')
        const c = sql[j]!
        if (c === '\\' && /[eE]/.test(ch)) {
          text += sql[j + 1] ?? ''
          j += 2
          continue
        }
        if (c === "'") {
          if (sql[j + 1] === "'") {
            text += "'"
            j += 2
            continue
          }
          break
        }
        text += c
        j += 1
      }
      tokens.push({ kind: 'string', text })
      i = j + 1
      continue
    }
    if (ch === '"' || ch === '`') {
      const [text, end] = quoted(ch, i + 1)
      tokens.push({ kind: 'word', text, lower: text.toLowerCase(), quoted: true })
      i = end
      continue
    }
    if (ch === '[' && dialect === 'sqlite') {
      const end = sql.indexOf(']', i + 1)
      if (end === -1) fail('unterminated [name]')
      const text = sql.slice(i + 1, end)
      tokens.push({ kind: 'word', text, lower: text.toLowerCase(), quoted: true })
      i = end + 1
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next))) {
      const match = /^(?:0x[0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
        sql.slice(i),
      )
      const text = match![0]
      tokens.push({ kind: 'number', text })
      i += text.length
      continue
    }
    if (ch === '$') {
      const digits = /^\$(\d+)/.exec(sql.slice(i))
      if (digits) {
        if (dialect !== 'postgres') fail('a $n placeholder in SQLite SQL')
        param(digits[0], Number(digits[1]) - 1)
        i += digits[0].length
        continue
      }
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag && dialect === 'postgres') {
        const end = sql.indexOf(tag[0], i + tag[0].length)
        if (end === -1) fail('unterminated dollar-quoted string')
        tokens.push({ kind: 'string', text: sql.slice(i + tag[0].length, end) })
        i = end + tag[0].length
        continue
      }
      const named = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i))
      if (named && dialect === 'sqlite') {
        param(named[0], undefined, named[1])
        i += named[0].length
        continue
      }
      fail('unexpected $')
    }
    if (dialect === 'sqlite' && (ch === ':' || ch === '@') && isWordStart(next)) {
      const named = /^[:@]([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i))!
      param(named[0], undefined, named[1])
      i += named[0].length
      continue
    }
    if (ch === '?' && dialect === 'sqlite') {
      const numbered = /^\?(\d+)/.exec(sql.slice(i))
      if (numbered) {
        param(numbered[0], Number(numbered[1]) - 1)
        i += numbered[0].length
      } else {
        param('?', sequential)
        sequential += 1
        i += 1
      }
      continue
    }
    if (ch === '?' && dialect === 'postgres') {
      // A JSON operator on Postgres: ?, ?| and ?&.
      const text = next === '|' || next === '&' ? `?${next}` : '?'
      tokens.push({ kind: 'op', text })
      i += text.length
      continue
    }
    if (isWordStart(ch)) {
      let j = i + 1
      while (j < sql.length && isWordPart(sql[j]!)) j += 1
      const text = sql.slice(i, j)
      tokens.push({ kind: 'word', text, lower: text.toLowerCase(), quoted: false })
      i = j
      continue
    }
    const operator = OPERATORS.find((op) => sql.startsWith(op, i))
    if (operator) {
      tokens.push({ kind: 'op', text: operator })
      i += operator.length
      continue
    }
    if (SINGLE_OPERATORS.has(ch)) {
      tokens.push({ kind: 'op', text: ch })
      i += 1
      continue
    }
    fail(`unexpected character ${JSON.stringify(ch)}`)
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

interface Source {
  readonly kind: 'table' | 'cte' | 'derived' | 'function'
  /** The table, CTE or function name (lower case, no schema). */
  readonly name: string
  /** The alias, lower case, when the item has one. */
  readonly alias: string | undefined
}

/** One top-level AND term, and which of its scope's sources it may restrict. */
interface Term {
  readonly start: number
  readonly end: number
  /** `all`: a WHERE term or an inner join's ON term; else only these sources. */
  readonly restricts: 'all' | ReadonlySet<Source>
}

interface Scope {
  readonly parent: Scope | undefined
  readonly sources: Source[]
  readonly terms: Term[]
  readonly children: Scope[]
  constrained: Set<Source>
}

/** An INSERT's target and where its workspace value comes from. */
interface InsertCheck {
  readonly table: string
  readonly scope: Scope
  readonly columns: readonly string[] | undefined
  /** Each VALUES row's expressions, as token ranges. */
  readonly rows: readonly (readonly Range[])[]
  /** The cores of an INSERT … SELECT, each with its result items. */
  readonly selects: readonly { readonly scope: Scope; readonly items: readonly Range[] }[]
  readonly defaultValues: boolean
  readonly conflictTargets: readonly (readonly string[] | 'constraint')[]
}

interface Range {
  readonly start: number
  readonly end: number
}

/** What the parser found in one statement text. */
interface Analysis {
  readonly tokens: readonly Token[]
  readonly roots: readonly Scope[]
  /** Every table reference: its name and whether it was read or written. */
  readonly references: readonly { readonly table: string; readonly write: boolean }[]
  readonly inserts: readonly InsertCheck[]
  /** Assignments to workspace_id, by target table. */
  readonly workspaceAssignments: readonly string[]
  /** The kind of each top-level statement. */
  readonly statementKinds: readonly ('select' | 'insert' | 'update' | 'delete')[]
  /** True when any statement, CTE or subquery writes. */
  readonly writes: boolean
}

const COMPOUND = new Set(['union', 'intersect', 'except'])
const SELECT_CLAUSES = new Set([
  'from',
  'where',
  'group',
  'having',
  'window',
  'order',
  'limit',
  'offset',
  'fetch',
  'for',
  'union',
  'intersect',
  'except',
  'returning',
  'on',
])
const JOIN_WORDS = new Set(['join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'outer'])
/** Words that end a FROM item, so they are never an alias. */
const NOT_ALIAS = new Set([
  ...SELECT_CLAUSES,
  ...JOIN_WORDS,
  'using',
  'set',
  'indexed',
  'not',
  'do',
  'values',
  'select',
  'with',
  'default',
  'as',
  'lateral',
])
const STATEMENT_START = new Set(['select', 'with', 'values'])

class Parser {
  private readonly pair: number[]
  private readonly references: { table: string; write: boolean }[] = []
  private readonly inserts: InsertCheck[] = []
  private readonly workspaceAssignments: string[] = []
  private readonly cteNames: Set<string>[] = []
  /** Every scope with no enclosing scope: each statement, and the CTEs and arms at its top. */
  private readonly roots: Scope[] = []
  private writes = false

  constructor(private readonly tokens: readonly Token[]) {
    this.pair = new Array<number>(tokens.length).fill(-1)
    const open: number[] = []
    tokens.forEach((token, index) => {
      if (token.kind !== 'op') return
      if (token.text === '(') open.push(index)
      else if (token.text === ')') {
        const start = open.pop()
        if (start === undefined) throw new UnparseableSqlError('unbalanced )')
        this.pair[start] = index
        this.pair[index] = start
      }
    })
    if (open.length > 0) throw new UnparseableSqlError('unbalanced (')
  }

  analyse(): Analysis {
    const kinds: Analysis['statementKinds'][number][] = []
    let i = 0
    const end = this.tokens.length
    while (i < end) {
      if (this.isOp(i, ';')) {
        i += 1
        continue
      }
      const root = this.newScope(undefined)
      const parsed = this.statement(i, end, root)
      kinds.push(parsed.kind)
      i = parsed.next
      if (i < end && !this.isOp(i, ';')) this.unexpected(i, 'the end of the statement')
    }
    if (kinds.length === 0) throw new UnparseableSqlError('no statement')
    return {
      tokens: this.tokens,
      roots: this.roots,
      references: this.references,
      inserts: this.inserts,
      workspaceAssignments: this.workspaceAssignments,
      statementKinds: kinds,
      writes: this.writes,
    }
  }

  // ---- token helpers ----

  private word(i: number): string | undefined {
    const token = this.tokens[i]
    return token?.kind === 'word' && !token.quoted ? token.lower : undefined
  }

  private isWord(i: number, ...words: string[]): boolean {
    const word = this.word(i)
    return word !== undefined && words.includes(word)
  }

  private isOp(i: number, text: string): boolean {
    const token = this.tokens[i]
    return token?.kind === 'op' && token.text === text
  }

  private expectWord(i: number, word: string): number {
    if (!this.isWord(i, word)) this.unexpected(i, word.toUpperCase())
    return i + 1
  }

  private unexpected(i: number, wanted: string): never {
    const token = this.tokens[i]
    throw new UnparseableSqlError(
      `expected ${wanted} at token ${i}, found ${token === undefined ? 'the end' : JSON.stringify(token.text)}`,
    )
  }

  private close(i: number): number {
    if (!this.isOp(i, '(')) this.unexpected(i, '(')
    return this.pair[i]!
  }

  private newScope(parent: Scope | undefined): Scope {
    const scope: Scope = { parent, sources: [], terms: [], children: [], constrained: new Set() }
    if (parent === undefined) this.roots.push(scope)
    else parent.children.push(scope)
    return scope
  }

  private isCte(name: string): boolean {
    return this.cteNames.some((names) => names.has(name))
  }

  /**
   * The index of the first token in [i, end) at paren depth 0 for which `stop` holds, or `end`.
   * CASE … END counts as a level, so its words never stop a clause.
   */
  private scan(i: number, end: number, stop: (j: number) => boolean): number {
    let caseDepth = 0
    for (let j = i; j < end; j++) {
      if (this.isOp(j, '(')) {
        j = this.pair[j]!
        continue
      }
      if (this.isWord(j, 'case')) caseDepth += 1
      else if (caseDepth > 0 && this.isWord(j, 'end')) caseDepth -= 1
      else if (caseDepth === 0 && stop(j)) return j
    }
    return end
  }

  /** Split [i, end) at depth-0 commas. */
  private commaList(i: number, end: number): Range[] {
    const out: Range[] = []
    let start = i
    for (;;) {
      const comma = this.scan(start, end, (j) => this.isOp(j, ','))
      out.push({ start, end: comma })
      if (comma >= end) return out
      start = comma + 1
    }
  }

  /** Parse every subquery inside [i, end) as a child scope of `scope`. */
  private subqueries(i: number, end: number, scope: Scope): void {
    for (let j = i; j < end; j++) {
      if (!this.isOp(j, '(')) continue
      if (STATEMENT_START.has(this.word(j + 1) ?? '')) {
        const close = this.pair[j]!
        const child = this.newScope(scope)
        const parsed = this.statement(j + 1, close, child)
        if (parsed.next !== close) this.unexpected(parsed.next, ')')
        j = close
      }
    }
  }

  // ---- statements ----

  /**
   * One statement in [i, end) whose first query scope is `scope` (a fresh scope the caller made).
   * Returns the statement's kind and the index after it.
   */
  private statement(
    i: number,
    end: number,
    scope: Scope,
  ): { kind: Analysis['statementKinds'][number]; next: number; cores: Core[] } {
    let pushed = false
    if (this.isWord(i, 'with')) {
      i += 1
      if (this.isWord(i, 'recursive')) i += 1
      const names = new Set<string>()
      this.cteNames.push(names)
      pushed = true
      for (;;) {
        const name = this.tokens[i]
        if (name?.kind !== 'word') this.unexpected(i, 'a CTE name')
        names.add(name.lower)
        i += 1
        if (this.isOp(i, '(')) i = this.close(i) + 1
        i = this.expectWord(i, 'as')
        if (this.isWord(i, 'not')) i += 1
        if (this.isWord(i, 'materialized')) i += 1
        const close = this.close(i)
        // A CTE body sees what the statement around it sees, not the statement's own sources.
        const body = this.newScope(scope.parent)
        const parsed = this.statement(i + 1, close, body)
        if (parsed.next !== close) this.unexpected(parsed.next, ')')
        i = close + 1
        if (!this.isOp(i, ',')) break
        i += 1
      }
    }
    try {
      if (this.isWord(i, 'select', 'values')) {
        const parsed = this.select(i, end, scope)
        return { kind: 'select', next: parsed.next, cores: parsed.cores }
      }
      if (this.isOp(i, '(') && STATEMENT_START.has(this.word(i + 1) ?? '')) {
        // A parenthesised select, possibly followed by a compound arm.
        const parsed = this.select(i, end, scope)
        return { kind: 'select', next: parsed.next, cores: parsed.cores }
      }
      if (this.isWord(i, 'insert', 'replace')) {
        this.writes = true
        return { kind: 'insert', next: this.insert(i, end, scope), cores: [] }
      }
      if (this.isWord(i, 'update')) {
        this.writes = true
        return { kind: 'update', next: this.update(i, end, scope), cores: [] }
      }
      if (this.isWord(i, 'delete')) {
        this.writes = true
        return { kind: 'delete', next: this.delete(i, end, scope), cores: [] }
      }
      return this.unexpected(i, 'SELECT, VALUES, INSERT, UPDATE or DELETE')
    } finally {
      if (pushed) this.cteNames.pop()
    }
  }

  /** A select (cores joined by UNION, INTERSECT, EXCEPT) and its trailing clauses. */
  private select(i: number, end: number, scope: Scope): { next: number; cores: Core[] } {
    const cores: Core[] = []
    let core = scope
    for (;;) {
      if (this.isOp(i, '(')) {
        const close = this.pair[i]!
        const parsed = this.statement(i + 1, close, core)
        if (parsed.next !== close) this.unexpected(parsed.next, ')')
        cores.push(...parsed.cores)
        i = close + 1
      } else {
        const parsed = this.selectCore(i, end, core)
        cores.push(parsed.core)
        i = parsed.next
      }
      if (i < end && COMPOUND.has(this.word(i) ?? '')) {
        i += 1
        if (this.isWord(i, 'all', 'distinct')) i += 1
        core = this.newScope(scope.parent)
        continue
      }
      break
    }
    // ORDER BY, LIMIT, OFFSET, FETCH, FOR UPDATE: expressions over the result; scan them.
    if (i < end && this.isWord(i, 'order', 'limit', 'offset', 'fetch', 'for')) {
      const stop = this.scan(i, end, (j) => this.isOp(j, ';') || this.isWord(j, 'on', 'returning'))
      this.subqueries(i, stop, scope)
      i = stop
    }
    return { next: i, cores }
  }

  private selectCore(i: number, end: number, scope: Scope): { next: number; core: Core } {
    if (this.isWord(i, 'values')) {
      i += 1
      const stop = this.scan(
        i,
        end,
        (j) => SELECT_CLAUSES.has(this.word(j) ?? '') || this.isOp(j, ';'),
      )
      this.subqueries(i, stop, scope)
      return { next: stop, core: { scope, items: undefined } }
    }
    i = this.expectWord(i, 'select')
    if (this.isWord(i, 'distinct')) {
      i += 1
      if (this.isWord(i, 'on')) i = this.close(i + 1) + 1
    } else if (this.isWord(i, 'all')) i += 1
    const listEnd = this.scan(
      i,
      end,
      (j) =>
        this.isOp(j, ';') ||
        (SELECT_CLAUSES.has(this.word(j) ?? '') &&
          // `a IS [NOT] DISTINCT FROM b` is an operator, not a FROM clause.
          !(this.isWord(j, 'from') && this.isWord(j - 1, 'distinct'))),
    )
    const items = this.commaList(i, listEnd)
    this.subqueries(i, listEnd, scope)
    i = listEnd
    if (this.isWord(i, 'from')) i = this.fromList(i + 1, end, scope)
    if (this.isWord(i, 'where')) i = this.condition(i + 1, end, scope, 'all')
    if (this.isWord(i, 'group')) {
      const stop = this.scan(
        i,
        end,
        (j) => this.isWord(j, 'having', 'window', ...SELECT_ENDS) || this.isOp(j, ';'),
      )
      this.subqueries(i, stop, scope)
      i = stop
    }
    if (this.isWord(i, 'having')) {
      const stop = this.scan(
        i + 1,
        end,
        (j) => this.isWord(j, 'window', ...SELECT_ENDS) || this.isOp(j, ';'),
      )
      this.subqueries(i, stop, scope)
      i = stop
    }
    if (this.isWord(i, 'window')) {
      const stop = this.scan(i + 1, end, (j) => this.isWord(j, ...SELECT_ENDS) || this.isOp(j, ';'))
      i = stop
    }
    if (i < end && !this.isOp(i, ';') && !this.isWord(i, ...SELECT_ENDS) && !this.isOp(i, ')')) {
      this.unexpected(i, 'a select clause')
    }
    return { next: i, core: { scope, items } }
  }

  /**
   * A FROM list (or UPDATE … FROM, DELETE … USING) into `scope`. Returns the index after it.
   */
  private fromList(i: number, end: number, scope: Scope): number {
    i = this.fromItem(i, end, scope)
    for (;;) {
      if (this.isOp(i, ',')) {
        i = this.fromItem(i + 1, end, scope)
        continue
      }
      if (!JOIN_WORDS.has(this.word(i) ?? '')) return i
      let side: 'inner' | 'left' | 'right' | 'full' = 'inner'
      while (!this.isWord(i, 'join')) {
        const word = this.word(i)
        if (word === undefined || !JOIN_WORDS.has(word)) this.unexpected(i, 'JOIN')
        if (word === 'left' || word === 'right' || word === 'full') side = word
        i += 1
      }
      i += 1
      const before = new Set(scope.sources)
      i = this.fromItem(i, end, scope)
      const joined = new Set(scope.sources.filter((source) => !before.has(source)))
      if (this.isWord(i, 'on')) {
        const restricts =
          side === 'inner'
            ? 'all'
            : side === 'left'
              ? joined
              : side === 'right'
                ? before
                : new Set<Source>()
        i = this.condition(i + 1, end, scope, restricts)
      } else if (this.isWord(i, 'using')) {
        i = this.close(i + 1) + 1
      }
    }
  }

  private fromItem(i: number, end: number, scope: Scope): number {
    if (this.isWord(i, 'lateral')) i += 1
    if (this.isOp(i, '(')) {
      const close = this.pair[i]!
      if (STATEMENT_START.has(this.word(i + 1) ?? '')) {
        const child = this.newScope(scope)
        const parsed = this.statement(i + 1, close, child)
        if (parsed.next !== close) this.unexpected(parsed.next, ')')
        const next = this.alias(close + 1)
        scope.sources.push({ kind: 'derived', name: '(subquery)', alias: next.alias })
        return next.next
      }
      // A parenthesised join: its items belong to this scope.
      const inner = this.fromList(i + 1, close, scope)
      if (inner !== close) this.unexpected(inner, ')')
      return this.alias(close + 1).next
    }
    const name = this.qualifiedName(i)
    i = name.next
    if (this.isOp(i, '(')) {
      // A table-valued function (json_each, jsonb_array_elements_text, unnest, ...).
      const close = this.pair[i]!
      this.subqueries(i + 1, close, scope)
      i = close + 1
      if (this.isWord(i, 'with') && this.isWord(i + 1, 'ordinality')) i += 2
      const next = this.alias(i)
      scope.sources.push({ kind: 'function', name: name.name, alias: next.alias })
      return next.next
    }
    const next = this.alias(i)
    i = next.next
    if (this.isWord(i, 'indexed')) i += 3
    else if (this.isWord(i, 'not') && this.isWord(i + 1, 'indexed')) i += 2
    if (this.isCte(name.name)) {
      scope.sources.push({ kind: 'cte', name: name.name, alias: next.alias })
    } else {
      scope.sources.push({ kind: 'table', name: name.name, alias: next.alias })
      this.references.push({ table: name.name, write: false })
    }
    return i
  }

  /** `name` or `schema.name`; the schema is dropped. */
  private qualifiedName(i: number): { name: string; next: number } {
    const first = this.tokens[i]
    if (first?.kind !== 'word' || (!first.quoted && NOT_ALIAS.has(first.lower))) {
      this.unexpected(i, 'a table name')
    }
    if (this.isOp(i + 1, '.')) {
      const second = this.tokens[i + 2]
      if (second?.kind !== 'word') this.unexpected(i + 2, 'a table name')
      return { name: second.lower, next: i + 3 }
    }
    return { name: first.lower, next: i + 1 }
  }

  /** An optional `[AS] alias [(columns)]`. */
  private alias(i: number): { alias: string | undefined; next: number } {
    let explicit = false
    if (this.isWord(i, 'as')) {
      explicit = true
      i += 1
    }
    const token = this.tokens[i]
    if (token?.kind === 'word' && (explicit || token.quoted || !NOT_ALIAS.has(token.lower))) {
      i += 1
      if (this.isOp(i, '(')) i = this.pair[i]! + 1
      return { alias: token.lower, next: i }
    }
    if (explicit) this.unexpected(i, 'an alias')
    return { alias: undefined, next: i }
  }

  /** A WHERE or ON condition: its top-level AND terms join `scope`, its subqueries are parsed. */
  private condition(i: number, end: number, scope: Scope, restricts: Term['restricts']): number {
    const stop = this.scan(
      i,
      end,
      (j) =>
        this.isOp(j, ';') ||
        this.isOp(j, ',') ||
        // `left(x, 1)` and `right(x, 1)` are functions, not joins.
        (JOIN_WORDS.has(this.word(j) ?? '') && !this.isOp(j + 1, '(')) ||
        // A FROM never follows a condition, except in `a IS [NOT] DISTINCT FROM b`.
        (this.isWord(j, 'from') && !this.isWord(j - 1, 'distinct')) ||
        this.isWord(
          j,
          'where',
          'group',
          'having',
          'window',
          'order',
          'limit',
          'offset',
          'fetch',
          'for',
          'union',
          'intersect',
          'except',
          'returning',
          'on',
          'using',
          'do',
        ),
    )
    for (const term of this.conjuncts(i, stop)) scope.terms.push({ ...term, restricts })
    this.subqueries(i, stop, scope)
    return stop
  }

  /** The top-level AND terms of [i, end); a disjunction is one opaque term. */
  private conjuncts(i: number, end: number): Range[] {
    while (i < end && this.isOp(i, '(') && this.pair[i] === end - 1) {
      if (STATEMENT_START.has(this.word(i + 1) ?? '')) break
      i += 1
      end -= 1
    }
    if (this.scan(i, end, (j) => this.isWord(j, 'or')) < end) return [{ start: i, end }]
    const parts: Range[] = []
    let start = i
    let between = false
    for (;;) {
      const and = this.scan(start, end, (j) => {
        if (this.isWord(j, 'between')) between = true
        else if (this.isWord(j, 'and')) {
          if (!between) return true
          between = false
        }
        return false
      })
      const part = { start, end: and }
      if (this.isOp(part.start, '(') && this.pair[part.start] === part.end - 1) {
        parts.push(...this.conjuncts(part.start, part.end))
      } else parts.push(part)
      if (and >= end) return parts
      start = and + 1
    }
  }

  // ---- writes ----

  private insert(i: number, end: number, scope: Scope): number {
    if (this.isWord(i, 'replace')) i += 1
    else {
      i = this.expectWord(i, 'insert')
      if (this.isWord(i, 'or')) i += 2
    }
    i = this.expectWord(i, 'into')
    const target = this.qualifiedName(i)
    i = target.next
    this.references.push({ table: target.name, write: true })
    if (this.isWord(i, 'as')) i += 2
    let columns: string[] | undefined
    if (this.isOp(i, '(') && !STATEMENT_START.has(this.word(i + 1) ?? '')) {
      const close = this.pair[i]!
      columns = this.commaList(i + 1, close).map((range) => this.columnName(range))
      i = close + 1
    }
    if (this.isWord(i, 'overriding')) i += 3
    const rows: Range[][] = []
    const selects: { scope: Scope; items: Range[] }[] = []
    let defaultValues = false
    if (this.isWord(i, 'default') && this.isWord(i + 1, 'values')) {
      defaultValues = true
      i += 2
    } else if (this.isWord(i, 'values')) {
      i += 1
      for (;;) {
        const close = this.close(i)
        rows.push(this.commaList(i + 1, close))
        this.subqueries(i + 1, close, scope)
        i = close + 1
        if (!this.isOp(i, ',')) break
        i += 1
      }
    } else {
      const body = this.newScope(scope)
      const parsed = this.statement(i, end, body)
      if (parsed.kind !== 'select') this.unexpected(i, 'VALUES or SELECT')
      for (const core of parsed.cores) {
        selects.push({ scope: core.scope, items: core.items ?? [] })
      }
      i = parsed.next
    }
    const conflictTargets: (string[] | 'constraint')[] = []
    while (this.isWord(i, 'on') && this.isWord(i + 1, 'conflict')) {
      i += 2
      if (this.isOp(i, '(')) {
        const close = this.pair[i]!
        conflictTargets.push(this.commaList(i + 1, close).map((range) => this.columnName(range)))
        i = close + 1
        if (this.isWord(i, 'where')) {
          i = this.scan(i + 1, end, (j) => this.isWord(j, 'do'))
        }
      } else if (this.isWord(i, 'on') && this.isWord(i + 1, 'constraint')) {
        conflictTargets.push('constraint')
        i += 3
      }
      i = this.expectWord(i, 'do')
      if (this.isWord(i, 'nothing')) {
        i += 1
        continue
      }
      i = this.expectWord(i, 'update')
      i = this.expectWord(i, 'set')
      i = this.assignments(i, end, scope, target.name)
      if (this.isWord(i, 'where')) {
        const stop = this.scan(
          i + 1,
          end,
          (j) => this.isWord(j, 'on', 'returning') || this.isOp(j, ';'),
        )
        this.subqueries(i + 1, stop, scope)
        i = stop
      }
    }
    i = this.returning(i, end, scope)
    this.inserts.push({
      table: target.name,
      scope,
      columns,
      rows,
      selects,
      defaultValues,
      conflictTargets,
    })
    return i
  }

  private update(i: number, end: number, scope: Scope): number {
    i = this.expectWord(i, 'update')
    if (this.isWord(i, 'or')) i += 2
    if (this.isWord(i, 'only')) i += 1
    const target = this.qualifiedName(i)
    i = target.next
    const alias = this.alias(i)
    i = alias.next
    scope.sources.push({ kind: 'table', name: target.name, alias: alias.alias })
    this.references.push({ table: target.name, write: true })
    if (this.isWord(i, 'indexed')) i += 3
    else if (this.isWord(i, 'not') && this.isWord(i + 1, 'indexed')) i += 2
    i = this.expectWord(i, 'set')
    i = this.assignments(i, end, scope, target.name)
    if (this.isWord(i, 'from')) i = this.fromList(i + 1, end, scope)
    if (this.isWord(i, 'where')) i = this.condition(i + 1, end, scope, 'all')
    i = this.returning(i, end, scope)
    return this.trailingOrderLimit(i, end, scope)
  }

  private delete(i: number, end: number, scope: Scope): number {
    i = this.expectWord(i, 'delete')
    i = this.expectWord(i, 'from')
    if (this.isWord(i, 'only')) i += 1
    const target = this.qualifiedName(i)
    i = target.next
    const alias = this.alias(i)
    i = alias.next
    scope.sources.push({ kind: 'table', name: target.name, alias: alias.alias })
    this.references.push({ table: target.name, write: true })
    if (this.isWord(i, 'indexed')) i += 3
    else if (this.isWord(i, 'not') && this.isWord(i + 1, 'indexed')) i += 2
    if (this.isWord(i, 'using')) i = this.fromList(i + 1, end, scope)
    if (this.isWord(i, 'where')) i = this.condition(i + 1, end, scope, 'all')
    i = this.returning(i, end, scope)
    return this.trailingOrderLimit(i, end, scope)
  }

  /** SQLite's `UPDATE/DELETE … ORDER BY … LIMIT …`. */
  private trailingOrderLimit(i: number, end: number, scope: Scope): number {
    if (!this.isWord(i, 'order', 'limit')) return i
    const stop = this.scan(i, end, (j) => this.isOp(j, ';'))
    this.subqueries(i, stop, scope)
    return stop
  }

  /** `SET a = x, (b, c) = (y, z)`; records an assignment to workspace_id. */
  private assignments(i: number, end: number, scope: Scope, table: string): number {
    const stop = this.scan(
      i,
      end,
      (j) =>
        this.isOp(j, ';') || this.isWord(j, 'from', 'where', 'returning', 'on', 'order', 'limit'),
    )
    for (const range of this.commaList(i, stop)) {
      const eq = this.scan(range.start, range.end, (j) => this.isOp(j, '='))
      if (eq >= range.end) this.unexpected(range.start, 'an assignment')
      const targets = this.isOp(range.start, '(')
        ? this.commaList(range.start + 1, this.pair[range.start]!)
        : [{ start: range.start, end: eq }]
      for (const column of targets) {
        if (this.columnName(column) === WORKSPACE_COLUMN) this.workspaceAssignments.push(table)
      }
    }
    this.subqueries(i, stop, scope)
    return stop
  }

  private returning(i: number, end: number, scope: Scope): number {
    if (!this.isWord(i, 'returning')) return i
    const stop = this.scan(i + 1, end, (j) => this.isOp(j, ';'))
    this.subqueries(i + 1, stop, scope)
    return stop
  }

  /** The last name of a column reference (`"t"."col"` gives `col`). */
  private columnName(range: Range): string {
    const last = this.tokens[range.end - 1]
    if (last?.kind !== 'word' || range.end <= range.start) {
      this.unexpected(range.start, 'a column name')
    }
    return last.lower
  }
}

const SELECT_ENDS = [
  'order',
  'limit',
  'offset',
  'fetch',
  'for',
  'union',
  'intersect',
  'except',
  'returning',
  'on',
]

/** One SELECT core: its scope and its result items (undefined for VALUES). */
interface Core {
  readonly scope: Scope
  readonly items: readonly Range[] | undefined
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

type Operand =
  | { readonly kind: 'param'; readonly name: string | undefined }
  | { readonly kind: 'column'; readonly qualifier: string | undefined; readonly column: string }
  | { readonly kind: 'other' }

/** Read one operand: a placeholder or a column, under parens and casts. */
function operand(tokens: readonly Token[], start: number, end: number): Operand {
  for (;;) {
    // Strip a trailing `::type` cast (with its own parens, brackets or words).
    let cast = -1
    let depth = 0
    for (let j = start; j < end; j++) {
      const token = tokens[j]!
      if (token.kind === 'op' && (token.text === '(' || token.text === '[')) depth += 1
      else if (token.kind === 'op' && (token.text === ')' || token.text === ']')) depth -= 1
      else if (depth === 0 && token.kind === 'op' && token.text === '::') {
        cast = j
        break
      }
    }
    if (cast !== -1) {
      end = cast
      continue
    }
    const first = tokens[start]
    const last = tokens[end - 1]
    if (first?.kind === 'op' && first.text === '(' && last?.kind === 'op' && last.text === ')') {
      start += 1
      end -= 1
      continue
    }
    // CAST(x AS type)
    if (
      first?.kind === 'word' &&
      !first.quoted &&
      first.lower === 'cast' &&
      tokens[start + 1]?.text === '(' &&
      last?.kind === 'op' &&
      last.text === ')'
    ) {
      let as = -1
      for (let j = end - 2; j > start + 1; j--) {
        const token = tokens[j]!
        if (token.kind === 'word' && !token.quoted && token.lower === 'as') {
          as = j
          break
        }
      }
      if (as === -1) return { kind: 'other' }
      start += 2
      end = as
      continue
    }
    break
  }
  if (end - start === 1 && tokens[start]!.kind === 'param') {
    const token = tokens[start] as Extract<Token, { kind: 'param' }>
    return { kind: 'param', name: token.name }
  }
  const words: string[] = []
  for (let j = start; j < end; j++) {
    const token = tokens[j]!
    if ((j - start) % 2 === 0) {
      if (token.kind !== 'word') return { kind: 'other' }
      words.push(token.lower)
    } else if (token.kind !== 'op' || token.text !== '.') return { kind: 'other' }
  }
  if (words.length === 0 || (end - start) % 2 === 0) return { kind: 'other' }
  return {
    kind: 'column',
    qualifier: words.length > 1 ? words[words.length - 2] : undefined,
    column: words[words.length - 1]!,
  }
}

/** A term as `left = right`, or undefined when it is not one plain equality. */
function equality(tokens: readonly Token[], range: Range): [Operand, Operand] | undefined {
  let at = -1
  let depth = 0
  for (let j = range.start; j < range.end; j++) {
    const token = tokens[j]!
    if (token.kind === 'op' && token.text === '(') depth += 1
    else if (token.kind === 'op' && token.text === ')') depth -= 1
    else if (depth === 0 && token.kind === 'op' && (token.text === '=' || token.text === '==')) {
      if (at !== -1) return undefined
      at = j
    } else if (depth === 0 && token.kind === 'word' && !token.quoted && token.lower === 'not') {
      return undefined
    }
  }
  if (at === -1) return undefined
  return [operand(tokens, range.start, at), operand(tokens, at + 1, range.end)]
}

/** The source a column names, looking outward from `scope`. */
function resolve(scope: Scope, column: Extract<Operand, { kind: 'column' }>): Source | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    if (column.qualifier !== undefined) {
      const found = current.sources.find((source) =>
        source.alias !== undefined
          ? source.alias === column.qualifier
          : source.name === column.qualifier,
      )
      if (found) return found
      continue
    }
    if (current.sources.length === 1) return current.sources[0]
    if (current.sources.length > 1) return undefined
  }
  return undefined
}

const isWorkspaceParam = (operand: Operand): boolean =>
  operand.kind === 'param' && operand.name === WORKSPACE_PLACEHOLDER

const isWorkspaceColumn = (operand: Operand): operand is Extract<Operand, { kind: 'column' }> =>
  operand.kind === 'column' && operand.column === WORKSPACE_COLUMN

const constrainedAnywhere = (scope: Scope, source: Source): boolean => {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    if (current.constrained.has(source)) return true
  }
  return false
}

const mayRestrict = (term: Term, source: Source): boolean =>
  term.restricts === 'all' || term.restricts.has(source)

/** Work out which sources of `scope` (and, after it, its children) are held to one workspace. */
function solve(tokens: readonly Token[], scope: Scope): void {
  const own = new Set(scope.sources)
  const equalities = scope.terms
    .map((term) => ({ term, sides: equality(tokens, term) }))
    .filter(
      (entry): entry is { term: Term; sides: [Operand, Operand] } => entry.sides !== undefined,
    )
  let changed = true
  while (changed) {
    changed = false
    for (const { term, sides } of equalities) {
      const [left, right] = sides
      for (const [a, b] of [
        [left, right],
        [right, left],
      ] as const) {
        if (!isWorkspaceColumn(a)) continue
        const source = resolve(scope, a)
        if (!source || !own.has(source) || scope.constrained.has(source)) continue
        if (!mayRestrict(term, source)) continue
        let holds = isWorkspaceParam(b)
        if (!holds && isWorkspaceColumn(b)) {
          const other = resolve(scope, b)
          holds = other !== undefined && other !== source && constrainedAnywhere(scope, other)
        }
        if (holds) {
          scope.constrained.add(source)
          changed = true
        }
      }
    }
  }
  for (const child of scope.children) solve(tokens, child)
}

function* allScopes(scope: Scope): Generator<Scope> {
  yield scope
  for (const child of scope.children) yield* allScopes(child)
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** Parse a statement; throws {@link UnparseableSqlError} on SQL the checker cannot read. */
function analyse(statement: ScopedStatement): Analysis {
  const dialect = statement.dialect ?? inferDialect(statement.sql)
  const tokens = tokenize(statement.sql, statement.placeholders, dialect)
  const analysis = new Parser(tokens).analyse()
  for (const root of analysis.roots) solve(tokens, root)
  return analysis
}

/** The tables a statement names, in order, with whether each is written. */
export function tableReferencesOf(
  statement: ScopedStatement,
): readonly { readonly table: string; readonly write: boolean }[] {
  return analyse(statement).references
}

/** Every finding for one statement of a definition of `scope`. */
export function checkWorkspaceScope(
  statement: ScopedStatement,
  scope: CheckedScope,
  options: ScopeCheckOptions,
): ScopeFinding[] {
  let analysis: Analysis
  try {
    analysis = analyse(statement)
  } catch (error) {
    if (!(error instanceof UnparseableSqlError)) throw error
    return [{ rule: 'unparseable', detail: error.message }]
  }
  const findings: ScopeFinding[] = []
  const kindOf = (table: string): TableKind | undefined => options.tableKind(table)
  const unknown = new Set<string>()
  for (const { table } of analysis.references) {
    if (kindOf(table) === undefined && !unknown.has(table)) {
      unknown.add(table)
      findings.push({ rule: 'unknown-table', table, detail: `${table} is not classified` })
    }
  }

  if (scope === 'global') {
    const seen = new Set<string>()
    for (const { table } of analysis.references) {
      if (kindOf(table) === 'workspace' && !seen.has(table)) {
        seen.add(table)
        findings.push({
          rule: 'global-workspace-table',
          table,
          detail: `a global definition names the workspace table ${table}`,
        })
      }
    }
    return findings
  }

  if (scope === 'across') {
    if (analysis.writes || analysis.statementKinds.some((kind) => kind !== 'select')) {
      findings.push({
        rule: 'across-write',
        detail: 'a cross-workspace definition must be a SELECT that writes nothing',
      })
    }
    return findings
  }

  const { tokens } = analysis
  for (const root of analysis.roots) {
    for (const current of allScopes(root)) {
      for (const source of current.sources) {
        if (source.kind !== 'table' || kindOf(source.name) !== 'workspace') continue
        if (current.constrained.has(source)) continue
        findings.push({
          rule: 'unconstrained',
          table: source.name,
          detail:
            `${source.name}${source.alias ? ` ${source.alias}` : ''} has no top-level AND term ` +
            `holding its workspace_id to the ${WORKSPACE_PLACEHOLDER} placeholder or to a constrained reference`,
        })
      }
    }
  }

  for (const insert of analysis.inserts) {
    if (kindOf(insert.table) !== 'workspace') continue
    findings.push(...insertFindings(tokens, insert))
    if (options.conflictTargets) {
      for (const target of insert.conflictTargets) {
        if (target !== 'constraint' && target.includes(WORKSPACE_COLUMN)) continue
        findings.push({
          rule: 'conflict-target',
          table: insert.table,
          detail: `an ON CONFLICT target of ${insert.table} does not include workspace_id`,
        })
      }
    }
  }

  for (const table of new Set(analysis.workspaceAssignments)) {
    if (kindOf(table) !== 'workspace') continue
    findings.push({
      rule: 'sets-workspace',
      table,
      detail: `an assignment to ${table}.workspace_id would move a row to another workspace`,
    })
  }
  return findings
}

function insertFindings(tokens: readonly Token[], insert: InsertCheck): ScopeFinding[] {
  const finding = (detail: string): ScopeFinding => ({
    rule: 'insert-workspace',
    table: insert.table,
    detail,
  })
  if (insert.defaultValues)
    return [finding(`INSERT INTO ${insert.table} DEFAULT VALUES names no workspace_id`)]
  const at = insert.columns?.indexOf(WORKSPACE_COLUMN) ?? -1
  if (insert.columns === undefined || at === -1) {
    return [finding(`INSERT INTO ${insert.table} does not name workspace_id`)]
  }
  const out: ScopeFinding[] = []
  insert.rows.forEach((row, index) => {
    const value = row[at]
    if (!value || !isWorkspaceParam(operand(tokens, value.start, value.end))) {
      out.push(
        finding(
          `row ${index + 1} of INSERT INTO ${insert.table} does not take workspace_id from the ${WORKSPACE_PLACEHOLDER} placeholder`,
        ),
      )
    }
  })
  for (const select of insert.selects) {
    const item = select.items[at]
    const value = item ? operand(tokens, item.start, item.end) : undefined
    const fromColumn =
      value !== undefined &&
      isWorkspaceColumn(value) &&
      (() => {
        const source = resolve(select.scope, value)
        return source !== undefined && constrainedAnywhere(select.scope, source)
      })()
    if (value === undefined || !(isWorkspaceParam(value) || fromColumn)) {
      out.push(
        finding(
          `the SELECT of INSERT INTO ${insert.table} does not take workspace_id from the placeholder or a constrained reference`,
        ),
      )
    }
  }
  return out
}
