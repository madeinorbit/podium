/**
 * THE `podium` ARGV PARSER (POD-3836) — one implementation, used by every
 * command parser in this app.
 *
 * The defect it exists to remove: every subcommand hand-rolled the same argv
 * loop into a loose `Record<string, unknown>`, and every one of them DROPPED a
 * flag it did not recognize. A mistyped or misplaced flag therefore succeeded
 * with default behaviour and said nothing — `lock acquire x --ttlx 1s` granted a
 * two-minute lease while the caller believed they had asked for one second, and
 * `lock status --branch dev/mw` listed every lock in the repo. Silence is the
 * worst available answer here: the caller cannot tell a no-op from a success,
 * which is exactly what POD-339's output contract forbids.
 *
 * So a flag is either DECLARED or it is an error. There is no third state, and
 * the error names the flag as it was typed plus the nearest thing that would
 * have worked, because a typo's whole difficulty is that the author cannot see
 * it.
 *
 * WHERE THE DECLARATION COMES FROM. For the registry-driven CLIs (issue, spec,
 * lock) it is DERIVED from the command's zod input shape — {@link
 * flagsFromZodShape} — so a flag cannot exist without a schema key and the two
 * cannot drift. That derivation also fixes the second half of the same bug: the
 * hand-maintained `BOOL_FLAGS` sets those parsers carried had to list every
 * boolean by hand, and a boolean the list forgot silently ate the next token as
 * its value (POD-1545: `--force-unknown-model` was spelled camel in the set and
 * kebab in argv, so it never matched). The zod shape already knows which keys
 * are booleans; asking it is the only spelling that cannot drift.
 *
 * The commands with no registry entry declare their flags explicitly with
 * {@link declareFlags}. That is a list a human maintains, but it is a list the
 * parser ENFORCES, which is the difference that matters.
 */

/** Kebab-case flag → camelCase key, so `--outside-scope` becomes `outsideScope`. */
export const camelFlag = (s: string): string =>
  s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** camelCase key → kebab-case flag, so `outsideScope` prints as `--outside-scope`. */
export const kebabFlag = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/**
 * A flag the command did not declare. Carries the pieces separately so a caller
 * can re-render it (`--json`) rather than scrape the message.
 */
export class UnknownFlagError extends Error {
  /** As typed, including the dashes: `--ttlx`. */
  readonly flag: string
  /** The nearest declared flag, if one is close enough to be worth naming. */
  readonly suggestion?: string

  constructor(flag: string, usage: string, suggestion?: string) {
    super(
      `unknown flag ${flag}${suggestion ? ` (did you mean ${suggestion}?)` : ''}` +
        ` — see \`${usage} --help\``,
    )
    this.name = 'UnknownFlagError'
    this.flag = flag
    if (suggestion !== undefined) this.suggestion = suggestion
  }
}

/** What one command accepts. Keys are spelled the way they appear in `args`. */
export interface FlagDeclaration {
  /** Every long flag the command accepts. */
  readonly known: ReadonlySet<string>
  /** The subset of {@link known} that takes no value. */
  readonly booleans: ReadonlySet<string>
  /** Short aliases: `f` → the long key `-f` means. */
  readonly shorts: ReadonlyMap<string, string>
  /**
   * Accept undeclared flags instead of refusing them. The ONE legitimate use is
   * the moment before an unknown COMMAND is named: `podium lock bogus --ttl 1m`
   * must be told its command does not exist, not that `--ttl` is unknown on a
   * command that is also unknown. Never for a command that exists.
   */
  readonly open?: boolean
}

/** Build a {@link FlagDeclaration} from plain lists. */
export function declareFlags(spec: {
  known: Iterable<string>
  booleans?: Iterable<string>
  shorts?: Readonly<Record<string, string>>
  open?: boolean
}): FlagDeclaration {
  const booleans = new Set(spec.booleans ?? [])
  return {
    // A boolean is a flag, so callers need not repeat it in both lists.
    known: new Set([...spec.known, ...booleans]),
    booleans,
    shorts: new Map(Object.entries(spec.shorts ?? {})),
    ...(spec.open === true ? { open: true } : {}),
  }
}

/** Merge declarations — a command's own flags plus the dispatcher's globals. */
export function mergeFlags(...decls: FlagDeclaration[]): FlagDeclaration {
  return {
    known: new Set(decls.flatMap((d) => [...d.known])),
    booleans: new Set(decls.flatMap((d) => [...d.booleans])),
    shorts: new Map(decls.flatMap((d) => [...d.shorts])),
  }
}

/** Levenshtein distance, iterative two-row form. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }
  return prev[b.length] ?? Math.max(a.length, b.length)
}

/**
 * The declared flag nearest `typed`, or undefined when nothing is close.
 *
 * The cutoff is deliberately tight — a suggestion that is not the flag the
 * author meant is worse than none, because they will try it. Two edits is a
 * typo; it must also be at most a third of the candidate's length, so a
 * three-letter flag is only ever offered for a one-edit miss.
 */
export function nearestFlag(typed: string, candidates: Iterable<string>): string | undefined {
  let best: { flag: string; d: number } | undefined
  for (const candidate of candidates) {
    const d = distance(typed.toLowerCase(), candidate.toLowerCase())
    if (d === 0) return `--${candidate}`
    if (d > 2 || d > Math.ceil(candidate.length / 3)) continue
    if (!best || d < best.d) best = { flag: candidate, d }
  }
  return best ? `--${best.flag}` : undefined
}

/** One flag as it appeared in argv, in argv order. */
export interface FlagOccurrence {
  /** As typed, including dashes. */
  readonly flag: string
  /** The `args` key it resolved to. */
  readonly key: string
  readonly value: string | boolean
}

export interface ParsedFlags {
  /** Last occurrence wins, which is what every flag but the repeatable ones wants. */
  readonly args: Record<string, string | boolean>
  readonly positionals: string[]
  /** Every occurrence in argv order — how a repeatable flag keeps its order. */
  readonly occurrences: FlagOccurrence[]
}

/** A single-dash token that is a value, not a flag: `-` itself and `-12`. */
function isNegativeOrLoneDash(token: string): boolean {
  return token === '-' || /^-\d/.test(token)
}

/**
 * argv → flags + positionals, refusing anything `decl` does not declare.
 *
 * `keys: 'camel'` (the default) writes `--outside-scope` as `outsideScope`;
 * `keys: 'raw'` keeps the kebab spelling, for the parsers whose call sites read
 * `args['expect-response']`. Either way the ERROR quotes the flag as the author
 * typed it — being told `--outsideScop` is unknown when you typed
 * `--outside-scop` is its own small insult.
 *
 * `usage` is the command path the reader is pointed at: `podium lock acquire`.
 */
export function parseFlags(
  tokens: readonly string[],
  decl: FlagDeclaration,
  opts: { usage: string; keys?: 'camel' | 'raw' },
): ParsedFlags {
  const args: Record<string, string | boolean> = {}
  const positionals: string[] = []
  const occurrences: FlagOccurrence[] = []
  const normalize = (name: string): string => (opts.keys === 'raw' ? name : camelFlag(name))
  const suggest = (name: string): string | undefined =>
    nearestFlag(name, [...decl.known].map(opts.keys === 'raw' ? (k) => k : kebabFlag))

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === undefined) continue
    let name: string
    let inline: string | undefined
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      name = eq >= 0 ? token.slice(2, eq) : token.slice(2)
      if (eq >= 0) inline = token.slice(eq + 1)
    } else if (token.startsWith('-') && token.length > 1 && !isNegativeOrLoneDash(token)) {
      const short = token.slice(1)
      const long = decl.shorts.get(short)
      if (long === undefined) {
        if (decl.open === true) {
          positionals.push(token)
          continue
        }
        throw new UnknownFlagError(token, opts.usage, suggest(short))
      }
      name = opts.keys === 'raw' ? long : kebabFlag(long)
    } else {
      positionals.push(token)
      continue
    }

    const key = normalize(name)
    if (decl.open !== true && !decl.known.has(key)) {
      throw new UnknownFlagError(
        token.startsWith('--') ? `--${name}` : token,
        opts.usage,
        suggest(name),
      )
    }

    let value: string | boolean
    if (inline !== undefined) {
      value = inline
    } else {
      const next = tokens[i + 1]
      if (decl.booleans.has(key) || next === undefined || next.startsWith('--')) {
        value = true
      } else {
        value = next
        i++
      }
    }
    args[key] = value
    occurrences.push({ flag: token.startsWith('--') ? `--${name}` : token, key, value })
  }
  return { args, positionals, occurrences }
}

/** The zod internals this module reads. Narrow on purpose: only the shape. */
interface ShapeCarrier {
  shape?: Record<string, { safeParse(v: unknown): { success: boolean } }>
}

/**
 * The strings a value flag might carry, probed against a field to decide whether
 * it takes a value at all. `'true'`/`'false'` are in the list deliberately — see
 * {@link flagsFromZodShape}.
 */
const VALUE_PROBES = ['a-value', 'true', 'false'] as const

/**
 * Derive a command's flag declaration from its zod input object.
 *
 * A key is a VALUE-LESS (boolean) flag iff its schema accepts `true` and accepts
 * NO string — a runtime probe rather than a walk over `_def.typeName`, because
 * the probe reads the same public surface every zod version keeps and cannot be
 * fooled by a wrapper (`.optional()`, `.default()`) it has not been taught about.
 *
 * BOTH halves are load-bearing, and the second one in a way that is easy to get
 * wrong. `z.union([z.string(), z.number()])` (lock's `--ttl`) refuses `true` and
 * so stays a value flag — the case the hand-maintained sets kept getting wrong.
 * But the issue registry's `cliBool` accepts `true` AND the strings `'true'` and
 * `'false'`, precisely so `--pinned`, `--pinned true` and `--pinned=false` all
 * work. Calling that value-less would make `--pinned false` parse as
 * `pinned: true` and leave `false` on the floor as a positional: the flag would
 * set exactly what its author asked it to clear. So a field that accepts any
 * string is a value flag, whatever else it also accepts.
 */
export function flagsFromZodShape(
  schema: unknown,
  globals?: { known?: Iterable<string>; booleans?: Iterable<string> },
): FlagDeclaration {
  const shape = (schema as ShapeCarrier).shape ?? {}
  const booleans = new Set<string>(globals?.booleans ?? [])
  const known = new Set<string>([...Object.keys(shape), ...(globals?.known ?? []), ...booleans])
  for (const [key, field] of Object.entries(shape)) {
    const takesTrue = field.safeParse?.(true).success === true
    const takesText = VALUE_PROBES.some((probe) => field.safeParse?.(probe).success === true)
    if (takesTrue && !takesText) booleans.add(key)
  }
  return { known, booleans, shorts: new Map() }
}

/**
 * {@link parseFlags} for callers that RETURN a failure instead of throwing one
 * — `resolvePlan` in cli.ts computes a `usage-error` plan rather than raising,
 * so the launch path stays a single typed decision.
 */
export function tryParseFlags(
  tokens: readonly string[],
  decl: FlagDeclaration,
  opts: { usage: string; keys?: 'camel' | 'raw' },
): ParsedFlags & { error?: string } {
  try {
    return parseFlags(tokens, decl, opts)
  } catch (err) {
    if (!(err instanceof UnknownFlagError)) throw err
    return { args: {}, positionals: [], occurrences: [], error: `${opts.usage}: ${err.message}` }
  }
}

/**
 * A per-command flag lookup for the CLIs with no zod registry to derive from
 * (mail, agent, offer, session, workflow, …).
 *
 * PER COMMAND, not per tool, and that is the point of the shape: the hand-rolled
 * rejections these replace used ONE set for the whole tool, so `mail inbox --to
 * someone` was accepted and silently ignored — a flag on the wrong command is
 * the same defect as a flag that does not exist.
 *
 * A command not in the table is OPEN, because a caller who typed a command that
 * does not exist should be told THAT, not that its flags are unknown too.
 */
export function flagTable(
  globals: FlagDeclaration,
  table: Readonly<
    Record<
      string,
      {
        known?: Iterable<string>
        booleans?: Iterable<string>
        shorts?: Readonly<Record<string, string>>
      }
    >
  >,
): (command: string | undefined) => FlagDeclaration {
  const built = new Map<string, FlagDeclaration>(
    Object.entries(table).map(([name, spec]) => [
      name,
      mergeFlags(declareFlags({ known: spec.known ?? [], ...spec }), globals),
    ]),
  )
  const open = declareFlags({ known: [], open: true })
  return (command) => (command != null ? (built.get(command) ?? open) : open)
}

/**
 * Run a parse, re-throwing an {@link UnknownFlagError} as the calling tool's own
 * error type with the message intact.
 *
 * Each `podium` sub-CLI has an error class that means "this is a USAGE problem,
 * not a transport one" — `logs-level-cli` branches on exactly that to decide
 * whether to append "is the server running?" to the message. An unknown flag is
 * as usage as it gets, so it must arrive wearing the same class rather than
 * teaching every catch site about a second one.
 */
export function withUnknownFlagAs<T>(wrap: (message: string) => Error, parse: () => T): T {
  try {
    return parse()
  } catch (err) {
    if (err instanceof UnknownFlagError) throw wrap(err.message)
    throw err
  }
}
