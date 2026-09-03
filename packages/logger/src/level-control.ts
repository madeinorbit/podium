import { type LogLevel, moreVerbose, parseLevel } from './levels'

/**
 * Level control: `PODIUM_LOG_LEVEL` for the global default, `PODIUM_LOG` for
 * per-namespace overrides (`"daemon:*=debug"`), `PODIUM_LOG_FLOOR` for
 * per-namespace FLOORS, and a programmatic setter for the runtimes that have no
 * env at all — a browser, a webview, a phone.
 *
 * Everything here is deliberately forgiving. A typo'd level in an env var must
 * not stop a process from booting or, worse, stop it from logging the reason it
 * did not; a bad entry is dropped and the rest of the spec still applies.
 *
 * ---------------------------------------------------------------------------
 * A FLOOR IS NOT AN OVERRIDE, AND THAT DISTINCTION IS THE WHOLE POINT (POD-3224)
 * ---------------------------------------------------------------------------
 *
 * Some namespaces are worth more than the process default, permanently, because
 * the questions asked of them are asked AFTER the fact and from a log file. The
 * update path is the canonical one: a client defaults to `warn`, so every line
 * describing what a Reload click actually did was written at `info` and thrown
 * away — the operator could see that a page was stale and never what it tried.
 *
 * A {@link setNamespaceLevel} override would fix that and break something else.
 * Rules are resolved MOST-SPECIFIC-WINS, so `web:updates=info` beats a global
 * raise to `debug` and silently CAPS the one namespace an operator raised the
 * client to debug in order to read. A floor cannot do that: it is folded in with
 * {@link moreVerbose}, so it can only ever make a namespace louder than the
 * default and never quieter than what somebody asked for.
 *
 * Floors compose by verbosity rather than by specificity, for the same reason:
 * two callers both saying "at least this much" want the union of what they
 * asked for, and the most specific pattern is not necessarily the one that
 * wanted the most.
 */

/** One `pattern=level` rule. `pattern` may contain `*`. */
export interface NamespaceRule {
  pattern: string
  level: LogLevel
}

/** The level a namespace gets when nothing says otherwise (spec: level table). */
export const DEFAULT_LEVEL: LogLevel = 'info'

interface LevelState {
  envGlobal: LogLevel | null
  envRules: readonly NamespaceRule[]
  programmaticGlobal: LogLevel | null
  programmaticRules: NamespaceRule[]
  envFloors: readonly NamespaceRule[]
  programmaticFloors: NamespaceRule[]
  version: number
}

const state: LevelState = {
  envGlobal: null,
  envRules: [],
  programmaticGlobal: null,
  programmaticRules: [],
  envFloors: [],
  programmaticFloors: [],
  version: 0,
}

let envRead = false

/**
 * Parse a `PODIUM_LOG` spec: `pattern=level` entries separated by commas,
 * semicolons, or whitespace. A bare level with no `=` is the global default,
 * so `PODIUM_LOG=debug` does the obvious thing.
 */
export function parseNamespaceSpec(spec: string): NamespaceRule[] {
  const rules: NamespaceRule[] = []
  for (const entry of spec.split(/[,;\s]+/)) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const eq = trimmed.lastIndexOf('=')
    if (eq === -1) {
      const bare = parseLevel(trimmed)
      if (bare) rules.push({ pattern: '*', level: bare })
      continue
    }
    const pattern = trimmed.slice(0, eq).trim()
    const level = parseLevel(trimmed.slice(eq + 1))
    if (pattern !== '' && level) rules.push({ pattern, level })
  }
  return rules
}

const patternCache = new Map<string, RegExp>()

function patternRegExp(pattern: string): RegExp {
  const cached = patternCache.get(pattern)
  if (cached) return cached
  // Every metacharacter is escaped and `*` alone is reinstated as `.*`, so a
  // namespace like `daemon.pty` is matched literally rather than as a regex.
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  const re = new RegExp(`^${source}$`)
  patternCache.set(pattern, re)
  return re
}

export function matchesNamespace(pattern: string, ns: string): boolean {
  return patternRegExp(pattern).test(ns)
}

/** Literal (non-wildcard) length — the specificity score. */
function specificity(pattern: string): number {
  return pattern.replaceAll('*', '').length
}

/**
 * The level for `ns` under `rules`, most specific match winning; ties go to the
 * later rule, so a caller can append an override without reordering.
 */
export function selectLevel(
  ns: string,
  rules: readonly NamespaceRule[],
  fallback: LogLevel,
): LogLevel {
  let best: LogLevel = fallback
  let bestScore = -1
  for (const rule of rules) {
    if (!matchesNamespace(rule.pattern, ns)) continue
    const score = specificity(rule.pattern)
    if (score >= bestScore) {
      best = rule.level
      bestScore = score
    }
  }
  return best
}

/**
 * Read `PODIUM_LOG_LEVEL`, `PODIUM_LOG` and `PODIUM_LOG_FLOOR`. Explicit env so
 * tests stay hermetic.
 *
 * `PODIUM_LOG_FLOOR` takes the same `pattern=level` spec as `PODIUM_LOG` and is
 * how an operator adds a floor of their own — or, with a quieter level than the
 * one a composition root installed, does NOT remove one: floors only ever
 * compose upwards. Turning a floored namespace back down is `setNamespaceFloor`
 * from the code that installed it, which is the party that knows why it is
 * there.
 */
export function configureLevelsFromEnv(env: Record<string, string | undefined>): void {
  state.envGlobal = parseLevel(env.PODIUM_LOG_LEVEL)
  state.envRules = env.PODIUM_LOG ? parseNamespaceSpec(env.PODIUM_LOG) : []
  state.envFloors = env.PODIUM_LOG_FLOOR ? parseNamespaceSpec(env.PODIUM_LOG_FLOOR) : []
  envRead = true
  state.version += 1
}

function ambientEnv(): Record<string, string | undefined> {
  // `process` is reached off globalThis rather than imported: this module is in
  // the browser bundle, and `node:process` would put a Node builtin in it.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env ?? {}
}

function ensureEnvRead(): void {
  if (envRead) return
  configureLevelsFromEnv(ambientEnv())
}

/**
 * The most verbose floor matching `ns`, or `null` when nothing floors it.
 *
 * Exported because the DAEMON's forwarding sink needs the same answer for a
 * different question. Its steady stream is a second threshold sitting on top of
 * the namespace level (`STEADY_FORWARD_LEVEL`), so a floored namespace would
 * resolve to `info` and still not leave the host. Reading the floor there keeps
 * "these namespaces are worth more" one declaration rather than two that can
 * disagree about which ones they are.
 */
export function namespaceFloor(ns: string): LogLevel | null {
  ensureEnvRead()
  let floor: LogLevel | null = null
  for (const rule of [...state.envFloors, ...state.programmaticFloors]) {
    if (!matchesNamespace(rule.pattern, ns)) continue
    floor = floor === null ? rule.level : moreVerbose(floor, rule.level)
  }
  return floor
}

/** The effective level for a namespace, floors included. */
export function resolveLevel(ns: string): LogLevel {
  ensureEnvRead()
  const globalDefault = state.programmaticGlobal ?? state.envGlobal ?? DEFAULT_LEVEL
  // Programmatic rules come last so they win ties against env rules of equal
  // specificity — a runtime override must beat the environment it started in.
  const selected = selectLevel(ns, [...state.envRules, ...state.programmaticRules], globalDefault)
  const floor = namespaceFloor(ns)
  return floor === null ? selected : moreVerbose(selected, floor)
}

/** Set the global default at runtime. Overrides `PODIUM_LOG_LEVEL`. */
export function setLogLevel(level: LogLevel): void {
  ensureEnvRead()
  state.programmaticGlobal = level
  state.version += 1
}

/** Set (or, with `null`, clear) a runtime override for one namespace pattern. */
export function setNamespaceLevel(pattern: string, level: LogLevel | null): void {
  ensureEnvRead()
  state.programmaticRules = state.programmaticRules.filter((rule) => rule.pattern !== pattern)
  if (level) state.programmaticRules.push({ pattern, level })
  state.version += 1
}

/**
 * Declare that `pattern` is worth AT LEAST `level`, whatever the process default
 * is — or, with `null`, withdraw that declaration.
 *
 * Composition roots call this; a raise never has to know about it, because a
 * floor cannot make anything quieter than what a raise asked for. See the
 * header for why this is not `setNamespaceLevel`.
 */
export function setNamespaceFloor(pattern: string, level: LogLevel | null): void {
  ensureEnvRead()
  state.programmaticFloors = state.programmaticFloors.filter((rule) => rule.pattern !== pattern)
  if (level) state.programmaticFloors.push({ pattern, level })
  state.version += 1
}

/**
 * Monotonic counter bumped on every configuration change. A logger caches its
 * emission gate and re-derives it when this moves — the alternative, a listener
 * list, is a leak waiting to happen in a package every module imports.
 */
export function levelConfigVersion(): number {
  return state.version
}

/** Drop all configuration, env included. Test and re-init hook. */
export function resetLevels(): void {
  state.envGlobal = null
  state.envRules = []
  state.programmaticGlobal = null
  state.programmaticRules = []
  state.envFloors = []
  state.programmaticFloors = []
  envRead = false
  state.version += 1
}
