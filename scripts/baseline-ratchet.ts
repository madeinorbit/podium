/**
 * THE BASELINE RATCHET — POD-3904, given its second direction by POD-3906.
 *
 * A ratchet whose expectation is a literal in the same file is not a ratchet.
 * `audit-ambient-principals.ts` measures how many places assume a default user
 * and compares that count against `BASELINE`, a hand-edited number sitting
 * twenty lines above the comparison. A regression and a fix are then the same
 * diff: raise the literal by five and the gate exits 0. POD-3903 demonstrated it
 * with the module's own exported check —
 *
 *     checkDrift({ firstAdminMemberId: 43 }, { firstAdminMemberId: 38 })  -> ['ambient-principal-added']
 *     checkDrift({ firstAdminMemberId: 43 }, { firstAdminMemberId: 43 })  -> []
 *
 * — and the baseline has in fact been raised once already, 41 -> 46 at
 * b12b5bae6 (POD-1669). That raise was argued for in the comment, so the
 * convention held. The convention was the only thing holding it.
 *
 * WHAT A COMMITTED NUMBER CANNOT DO. No check living beside the number can see
 * a raise, because a raise makes the file self-consistent. A sibling test does
 * not fix this either: the repo's existing threshold tests are written
 * RELATIVELY (`MIN_ID_FIELD_SITES + 10`, `CLIENT_FILE_FLOOR.web - 1`,
 * `DAEMON_COMPOSITION_ROOT_MAX_LINES + 1`), so they prove the check fires at
 * its boundary and then float with the constant — edit the constant and they
 * stay green. The only value the working tree cannot edit is the one on the
 * commit the branch started from.
 *
 * SO THIS MODULE READS THE BASELINE OUT OF GIT. `baseRevision()` resolves the
 * merge base with the integration branch, `constantsAtRevision()` parses the
 * baseline out of the file AS IT WAS THERE, and `checkBaseline()` fails a move
 * in the unsafe direction unless the working tree carries a
 * `BaselineAuthorisation` that names the OLD value, the NEW value, an issue and
 * a reason. An author cannot write that
 * entry without having looked up what they are raising from, and a reviewer
 * sees it as a block of prose rather than a digit.
 *
 * MERGE BASE, NOT THE TIP, deliberately: a raise is relative to what this
 * branch INHERITED. If a sibling lands a legitimate lowering on main while this
 * branch is open, the tip would make an unchanged baseline look like a raise —
 * a false red that teaches people to pass `--no-require-base`. The merge base
 * answers the question actually being asked: did THIS branch move it up?
 *
 * WHICH DIRECTION IS UNSAFE IS A PROPERTY OF THE KEY — POD-3906. POD-3904 built
 * this for a CEILING, where the escape is raising the number, and let every
 * fall through free. Half this repository's committed numbers are the other
 * shape: `MIN_ID_FIELD_SITES`, `CLIENT_FILE_FLOOR`, `MIN_SCANNED_FILES` are
 * FLOORS, and for those the free direction is the dangerous one — lowering a
 * coverage floor to zero is a scan that measures nothing and still exits 0.
 *
 * The proof that this was not a theoretical gap is this module's own record.
 * The single authorisation in the repository documents `FIRST_ADMIN_USER_ID` 46
 * -> `firstAdminMemberId` 42 -> 38. Three movements, every one DOWNWARD, and
 * until `BaselineDirection` existed the check only ever compared upward: the
 * instrument's entire recorded history is travel in the direction it did not
 * guard. `scripts/audit-committed-floors.ts` is the census that now holds the
 * floors, and `BaselineDirection` below says why there is no default direction.
 *
 * AND IT MUST BE ABLE TO SAY IT COULDN'T LOOK. A comparison against history is
 * unavailable in a shallow clone, in a tree with no integration branch, and
 * outside a repository. Silently passing there would be the POD-1369 class of
 * instrument all over again, so the unavailable case is reported by name and
 * `--require-base` (which CI passes) turns it into a failure.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// The parser, not a regex: a baseline is a value, and matching its spelling is
// how four separate enumerations under-reported while this issue was being
// worked. `typescript` is already a devDependency of @podium/scripts, and
// `store-coverage-census.ts` and `scan-hidden-store-reads.ts` import it the
// same way.
import ts from 'typescript'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Branches a raise is measured against, in order of preference. */
export const INTEGRATION_REFS = ['origin/main', 'main'] as const

export interface Finding {
  check: string
  where: string
  detail: string
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export type GitRunner = (args: readonly string[]) => { ok: boolean; stdout: string }

/** Real git, scoped to the repository this file lives in. */
export const gitIn =
  (root = REPO_ROOT): GitRunner =>
  (args) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    return { ok: r.exitCode === 0, stdout: new TextDecoder().decode(r.stdout).trim() }
  }

export interface BaseRevision {
  /** The commit the comparison reads, or null when there is nothing to read. */
  readonly commit: string | null
  /** How it was chosen, or why it could not be — printed, always. */
  readonly how: string
}

/**
 * The commit this branch started from.
 *
 * `PODIUM_RATCHET_BASE` overrides everything, for CI shapes this does not know
 * about and for reproducing a verdict by hand.
 *
 * On the integration branch itself the merge base IS HEAD, which would compare
 * the file against itself and pass unconditionally — so that case falls through
 * to the previous commit, which is the right question for a push to main.
 */
export const baseRevision = (git: GitRunner = gitIn(), env = process.env): BaseRevision => {
  const override = env.PODIUM_RATCHET_BASE?.trim()
  if (override) {
    const resolved = git(['rev-parse', '--verify', `${override}^{commit}`])
    return resolved.ok
      ? { commit: resolved.stdout, how: `PODIUM_RATCHET_BASE=${override}` }
      : { commit: null, how: `PODIUM_RATCHET_BASE=${override} does not resolve to a commit` }
  }

  const head = git(['rev-parse', '--verify', 'HEAD'])
  if (!head.ok) return { commit: null, how: 'not a git repository, or HEAD is unborn' }

  for (const ref of INTEGRATION_REFS) {
    const exists = git(['rev-parse', '--verify', `${ref}^{commit}`])
    if (!exists.ok) continue
    const mergeBase = git(['merge-base', 'HEAD', ref])
    if (!mergeBase.ok) continue
    if (mergeBase.stdout !== head.stdout)
      return { commit: mergeBase.stdout, how: `merge-base HEAD ${ref}` }
    // We are on (or at the tip of) the integration branch: compare with what
    // the commit before this one said.
    const parent = git(['rev-parse', '--verify', 'HEAD^{commit}^'])
    return parent.ok
      ? { commit: parent.stdout, how: `HEAD^ (HEAD is the merge base with ${ref})` }
      : { commit: null, how: `HEAD is the merge base with ${ref} and has no parent` }
  }
  return {
    commit: null,
    how: `no integration branch present (looked for ${INTEGRATION_REFS.join(', ')}) — a shallow clone cannot answer this`,
  }
}

/** A file as of a commit, or null when it did not exist there. */
export const fileAtRevision = (
  commit: string,
  relativePath: string,
  git: GitRunner = gitIn(),
): string | null => {
  const shown = git(['show', `${commit}:${relativePath}`])
  return shown.ok ? shown.stdout : null
}

// ---------------------------------------------------------------------------
// Parsing a baseline out of a source file
// ---------------------------------------------------------------------------

/**
 * Every number reachable from `export const <name>`, keyed by its dotted path.
 *
 * A bare `export const THRESHOLD = 600` yields `{ '': 600 }`; an object literal
 * yields one entry per numeric property. Structural, so a rename of the file's
 * private helpers or a reflow of the literal changes nothing here.
 */
export const constantsIn = (source: string, exportName: string): Record<string, number> => {
  const sf = ts.createSourceFile('baseline.ts', source, ts.ScriptTarget.Latest, true)
  const out: Record<string, number> = {}
  const numbersIn = (node: ts.Node, path: string): void => {
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
      numbersIn(node.expression, path)
      return
    }
    if (ts.isNumericLiteral(node)) {
      out[path] = Number(node.text)
      return
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const key = ts.isStringLiteralLike(prop.name)
          ? prop.name.text
          : prop.name.getText(sf).replace(/^['"`]|['"`]$/g, '')
        numbersIn(prop.initializer, path === '' ? key : `${path}.${key}`)
      }
    }
  }
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (decl.name.getText(sf) !== exportName || !decl.initializer) continue
      numbersIn(decl.initializer, '')
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * The record a raise costs. `from` is the value on the base commit — an author
 * cannot fill it in without looking up what they are raising, which is the
 * whole mechanism. `issue` and `reason` are what the reviewer reads.
 */
export interface BaselineAuthorisation {
  readonly key: string
  readonly from: number
  readonly to: number
  readonly issue: string
  readonly reason: string
  /**
   * Set when the baseline was RENAMED rather than raised: the key it is spelled
   * under now. `from` is still the old key's value on the base commit and `to`
   * is the new key's value here, so a rename that also moved the number shows
   * both halves instead of hiding one behind the other.
   */
  readonly renamedTo?: string
}

/** Long enough that "fix later" does not fit. */
export const MIN_REASON_LENGTH = 40

/**
 * WHICH WAY A BASELINE MAY NOT MOVE — POD-3906.
 *
 * `ceiling` is the shape POD-3904 was built for: the measurement must stay AT
 * OR BELOW the number, so the escape is raising it and a fall is free.
 * `floor` is its mirror: the measurement must stay AT OR ABOVE the number, so
 * the escape is LOWERING it and a rise is free.
 *
 * Per KEY, not per instrument, because one instrument holds both: an audit that
 * caps how many places assume a default user can equally carry a floor under
 * how many files its scan must reach before the count means anything.
 *
 * There is deliberately NO DEFAULT. A default would reintroduce this issue one
 * level up — add a floor, forget to declare it, and it quietly gets ceiling
 * semantics, which leaves lowering it to zero unguarded. An enforced key with
 * no declared direction is reported rather than guessed at.
 */
export type BaselineDirection = 'ceiling' | 'floor'

export interface BaselineInput {
  /** The instrument's name, for the message. */
  readonly instrument: string
  /** The baseline in the working tree. */
  readonly current: Readonly<Record<string, number>>
  /** The same baseline on the base commit, or null when it could not be read. */
  readonly base: Readonly<Record<string, number>> | null
  readonly authorisations: readonly BaselineAuthorisation[]
  /** Only these keys gate; the rest are reported by their own audit. */
  readonly enforced: readonly string[]
  /**
   * Which way each enforced key may not move. Required, and required for EVERY
   * enforced key — see {@link BaselineDirection} for why there is no default.
   */
  readonly directions: Readonly<Record<string, BaselineDirection>>
  /** How the base was resolved, for the message. */
  readonly how: string
  /** CI passes this: an unavailable comparison becomes a failure. */
  readonly requireBase: boolean
}

/**
 * Findings for baselines that MOVED UP, and for enforced keys that vanished.
 *
 * The second half is not defensive padding. `FIRST_ADMIN_USER_ID` became
 * `firstAdminMemberId` at 65be6da71 carrying its value across, so a rename is a
 * demonstrated way for a baseline to lose its history — and renaming a key is
 * as cheap an escape as raising its value if only the raise is guarded.
 */
export const checkBaseline = (input: BaselineInput): Finding[] => {
  const { instrument, current, base, authorisations, enforced, directions, how, requireBase } =
    input

  if (base === null) {
    if (!requireBase) return []
    return [
      {
        check: 'baseline-base-unavailable',
        where: instrument,
        detail: `could not read the baseline on the base commit (${how}), so a raise could not be ruled out. This run was asked to require the comparison. Fetch enough history (actions/checkout needs fetch-depth: 0) or set PODIUM_RATCHET_BASE.`,
      },
    ]
  }

  const findings: Finding[] = []
  const authorises = (key: string, from: number, to: number): BaselineAuthorisation | undefined =>
    authorisations.find(
      (a) =>
        a.key === key &&
        a.from === from &&
        a.to === to &&
        a.issue.trim().length > 0 &&
        a.reason.trim().length >= MIN_REASON_LENGTH,
    )

  // Every key EITHER side knows about. Iterating only the current tree's keys
  // would be blind by construction to the two escapes that are not a raise: a
  // key that vanished (renamed, carrying its value across), and a key that is
  // still there but no longer enforced.
  const keys = [...new Set([...Object.keys(base), ...enforced])].sort()

  for (const key of keys) {
    const was = base[key]
    const now = current[key]

    // Nothing on the base commit: a new baseline, which is a floor being set
    // rather than moved. The audit's own drift check covers it from here.
    if (was === undefined) continue

    if (now === undefined) {
      const retirement = authorisations.find(
        (a) =>
          a.key === key &&
          a.renamedTo !== undefined &&
          a.from === was &&
          a.to === current[a.renamedTo] &&
          a.issue.trim().length > 0 &&
          a.reason.trim().length >= MIN_REASON_LENGTH,
      )
      if (retirement) continue

      // A retirement entry that no longer matches is the case a reader will
      // hit most often once a rename has landed: the entry pins the new key's
      // value, so a later raise breaks it. Saying "the key disappeared" there
      // would send them after the rename instead of after the number.
      const drifted = authorisations.find(
        (a) => a.key === key && a.renamedTo !== undefined && a.from === was,
      )
      if (drifted?.renamedTo !== undefined) {
        const now_ = current[drifted.renamedTo]
        // The direction of the key AS IT IS SPELLED NOW: a rename does not
        // change which way the gate looks, and reporting a collapsed floor as
        // a raise sends the reader after the opposite defect.
        const renamedDirection = directions[drifted.renamedTo] ?? directions[key] ?? 'ceiling'
        findings.push({
          check:
            renamedDirection === 'ceiling'
              ? 'baseline-raised-without-authorisation'
              : 'baseline-lowered-without-authorisation',
          where: `${instrument}:${drifted.renamedTo}`,
          detail:
            now_ === undefined
              ? `\`${key}\` was retired into \`${drifted.renamedTo}\`, which this tree does not baseline at all.`
              : now_ === drifted.to
                ? `the retirement of \`${key}\` into \`${drifted.renamedTo}\` is recorded with the right numbers (${was} -> ${now_}) but an incomplete record: it needs an issue and a reason of at least ${MIN_REASON_LENGTH} characters.`
                : `\`${key}\` was ${was} on the base commit (${how}) and was retired into \`${drifted.renamedTo}\`, whose authorisation records it at ${drifted.to}. This tree baselines it at ${now_}. A renamed baseline is still the same baseline: update the authorisation's \`to\` and say why it moved, or put the number back.`,
        })
        continue
      }

      findings.push({
        check: 'baseline-key-disappeared',
        where: `${instrument}:${key}`,
        detail: `the base commit (${how}) baselines \`${key}\` at ${was} and this tree has no such key. A rename carries the value across and loses its history — which is exactly how \`FIRST_ADMIN_USER_ID\` became \`firstAdminMemberId\` still holding 46, and it is as cheap an escape as editing the number. If the rename is deliberate, record it: a BaselineAuthorisation { key: '${key}', from: ${was}, renamedTo: '<the new key>', to: <its value here>, issue, reason }.`,
      })
      continue
    }

    if (!enforced.includes(key)) {
      findings.push({
        check: 'baseline-enforcement-dropped',
        where: `${instrument}:${key}`,
        detail: `\`${key}\` was enforced on the base commit (${how}) at ${was} and still has a baseline of ${now} here, but this tree no longer enforces it. Turning a gate into a report is a way to accept a regression without touching its number.`,
      })
      continue
    }

    // WHICH WAY, before HOW FAR. Asked of every enforced key and not only of
    // one that moved: the direction is a property of the CHECK, so a key
    // carrying none is unguarded from the moment somebody does move it, and
    // waiting for that movement to complain is waiting for the escape.
    const direction = directions[key]
    if (direction === undefined) {
      findings.push({
        check: 'baseline-direction-undeclared',
        where: `${instrument}:${key}`,
        detail: `\`${key}\` is enforced at ${now} but this tree does not say which way it may not move, so nothing can tell a regression from a fix. Declare it: 'ceiling' if the measurement must stay at or below the number (the escape is raising it), 'floor' if it must stay at or above it (the escape is lowering it). There is no default on purpose — a guessed direction leaves the other half unguarded.`,
      })
      continue
    }

    // The safe direction is free, and it is the OPPOSITE one for a floor. This
    // single line is the issue: until POD-3906 every key took the ceiling
    // branch, so the three movements the repository's one authorisation
    // records (46 -> 42 -> 38) all fell through it untouched.
    const moved = direction === 'ceiling' ? now - was : was - now
    if (moved <= 0) continue

    const authorisation = authorises(key, was, now)
    if (authorisation) continue

    const verb = direction === 'ceiling' ? 'rose' : 'fell'
    const near = authorisations.find((a) => a.key === key && a.to === now)
    const why = near
      ? near.from !== was
        ? `Its authorisation says it ${verb} from ${near.from}, but the base commit says ${was}.`
        : near.issue.trim().length === 0
          ? 'Its authorisation names no issue.'
          : `Its authorisation's reason is ${near.reason.trim().length} characters; ${MIN_REASON_LENGTH} is the minimum.`
      : 'There is no authorisation for it.'

    const movement = `${direction} ${was} -> ${now} (${direction === 'ceiling' ? '+' : '-'}${moved})`
    const howItHides =
      direction === 'ceiling'
        ? 'A raise is how a regression is made to look like a pass'
        : 'A lowering is how a floor is made to accept the collapse it exists to catch — a coverage floor lowered to zero is a scan that measures nothing and still exits 0'
    findings.push({
      check:
        direction === 'ceiling'
          ? 'baseline-raised-without-authorisation'
          : 'baseline-lowered-without-authorisation',
      where: `${instrument}:${key}`,
      detail: `${movement} against ${how}. ${howItHides}, so it costs a record: add a BaselineAuthorisation { key: '${key}', from: ${was}, to: ${now}, issue, reason } naming what moved and why it is acceptable. ${why}`,
    })
  }

  return findings
}

/**
 * Read `exportName` out of `relativePath` as of the base commit and check the
 * working tree's value against it.
 */
export const checkBaselineAgainstBase = (
  opts: Omit<BaselineInput, 'base' | 'how'> & {
    readonly relativePath: string
    readonly exportName: string
    readonly git?: GitRunner
    readonly env?: NodeJS.ProcessEnv
  },
): { findings: Finding[]; how: string; base: Record<string, number> | null } => {
  const git = opts.git ?? gitIn()
  const { commit, how } = baseRevision(git, opts.env)
  const source = commit === null ? null : fileAtRevision(commit, opts.relativePath, git)
  // `base === null` means WE COULD NOT LOOK — no commit, or the file was not
  // there. An empty record means we looked and the base had no such baseline,
  // which is what a genuinely new instrument looks like and is not a failure;
  // it is spelled out in `how` so a reader can tell the two apart.
  const base = source === null ? null : constantsIn(source, opts.exportName)
  const resolvedHow =
    commit === null
      ? how
      : source === null
        ? `${how} (${commit.slice(0, 9)}) — ${opts.relativePath} did not exist there`
        : base !== null && Object.keys(base).length === 0
          ? `${how} (${commit.slice(0, 9)}) — no \`${opts.exportName}\` there`
          : `${how} (${commit.slice(0, 9)})`
  return {
    findings: checkBaseline({ ...opts, base, how: resolvedHow }),
    how: resolvedHow,
    base,
  }
}

/** For a caller that wants the working tree's own value the same way. */
export const constantsInFile = (relativePath: string, exportName: string): Record<string, number> =>
  constantsIn(readFileSync(join(REPO_ROOT, relativePath), 'utf8'), exportName)
