/**
 * The span-effect lint (POD-3332, epic POD-3221) — spec §6 rule 19 as a check a
 * tool makes instead of a person.
 *
 * THE RULE IT ENCODES, and it is not "no non-database call in a span": *if the
 * transaction rolled back, would anything outside this process be wrong for
 * having seen this?* A diagnostic `log.warn` has no observer and stays where it
 * is — the store's quarantine warnings are the live example and this lint must
 * never flag them. An event, a mail nudge, a git round trip, a file the
 * filesystem now lacks: those move to one of spec §3.3's post-commit
 * mechanisms, and a span body that can still reach one is what this reports.
 *
 * WHY IT EXISTS. POD-3260 classified every span by hand and its ledger §F says
 * plainly that the acceptance sentence is not checkable by reading, naming two
 * spans whose fan-out is too deep to certify: `IssueAttachOrchestrator.execute`
 * and `MaintenanceService.write`. This is the epic's own first principle —
 * completeness comes from the compiler and a lint, never from grep or memory —
 * applied to the one B-prep category that had no compiler check.
 *
 * HOW IT IS A GATE AND NOT AN ADVISORY. The execution method records POD-3257's
 * proof that a name-matching scan cannot carry a rule of this shape. Nothing
 * here matches on a name: {@link analyze} resolves every callee through the type
 * checker, so a call made through a local `const` or a closure is followed, and
 * `Map.get` is dropped because of where it is DECLARED, not because of what it
 * is called. What the rule cannot see it says out loud rather than passing:
 * unresolved calls, opaque span bodies and unclassified port members are all
 * reported, and an unclassified port member FAILS.
 *
 * THREE THINGS FAIL IT:
 *
 *  1. A span body reaching an `observable` capability that is not on
 *     {@link ACCEPTED} — a NEW site, which is the whole point.
 *  2. An `unknown` capability — a port member nobody has classified. Not a
 *     warning: an unclassified port is a rule that has quietly stopped covering
 *     something, and the fix is one line in `PORT_CAPABILITIES`.
 *  3. The tables rotting: an opener that matched nothing, a `transact`
 *     declaration neither table names, a not-an-opener pin whose line no longer
 *     holds a declaration, or an {@link ACCEPTED} entry with no finding left
 *     (slack — the site was fixed and the ledger line must go).
 *
 * Run: `bun run lint:span-effects` (also `--json`, `--report`).
 */

import { relative, resolve } from 'node:path'
import {
  type AnalysisResult,
  analyze,
  createProjectProgram,
  type SpanFinding,
} from './span-effect-graph'

/** The two directories B0.5's acceptance sentence names. */
const ROOT_SCOPE = ['apps/server/src/', 'packages/sync/src/']

/**
 * Where a call may be FOLLOWED. Wider than the roots on purpose: a server span
 * reaches `@podium/model` and `@podium/protocol`, and stopping at the package
 * boundary would turn every one of those calls into an unclassified port.
 */
const WALK_SCOPE = ['apps/', 'packages/']

/**
 * The findings that stand today, one line each, with the reason they stand.
 *
 * IT IS NOT AN ALLOWLIST OF VIOLATIONS, for the same reason POD-3252's
 * `STAGE_A_UNCONVERTED` is not: it excuses no construct and hides no class of
 * defect. It names the sites POD-3260's ledger §F said could not be certified by
 * hand, now certified BY THIS LINT, and it is the artefact that makes the rule
 * gate-able on the tree it was written against rather than red from the day it
 * lands. An entry that stops matching FAILS (see `slack` below), so the list
 * shrinks and cannot rot.
 *
 * Keyed `<capability key>@<root file>:<root line>`.
 */
interface AcceptedFinding {
  readonly key: string
  readonly why: string
}

const ACCEPTED: readonly AcceptedFinding[] = [
  {
    key: 'node:fs/promises.rm@apps/server/src/application/issue-attach-orchestrator.ts:26',
    why: "the attach orchestrator's span reaches IssueArtifactStore.removeIssue through draft cleanup, and an rm(recursive) is not something a rollback takes back. This is the same capability as the four fire-and-forget sites the ledger §F left unsettled; POD-3260 could not demonstrate it, and this is the demonstration.",
  },
  {
    key: 'apps/server/src/modules/issues/service/types.ts#IssueDeps.onIssueCreated@apps/server/src/application/issue-attach-orchestrator.ts:26',
    why: "the analytics publication hook, whose own doc says it is 'for a composition root that publishes it'. Reached from issue creation inside the attach span.",
  },
  {
    key: 'apps/server/src/modules/issues/service/types.ts#IssueDeps.onIssueClosed@apps/server/src/application/issue-attach-orchestrator.ts:26',
    why: 'starts session teardown, which tears down processes outside this one, from inside the attach span. STILL CALLED in the span, but no longer ACTING in it: POD-3806 moved the drop one level down, so `IssueSessionLifecycle.stopClosedIssue` registers the teardown with afterCommit and it runs once the span commits. The line stays because the call is what the graph can see, and the deferral is a fact about the callee.',
  },
  {
    key: 'packages/sync/src/authority/ports.ts#ChangeSubscriber.ChangeSubscriber@apps/server/src/application/issue-attach-orchestrator.ts:26',
    why: 'Authority.finalize publishes immediately when AuthorityDeps.postCommit is UNSET, and relay.ts sets it — ledger §A row 3. The immediate branch is real code the type system cannot tell is unreachable in the server, so the lint sees it and this line records why it stands.',
  },
  {
    key: 'apps/server/src/modules/sessions/session.ts#Send.Send@apps/server/src/modules/sessions/session-meta-ops.ts:365',
    why: "THE ROLLBACK'S OWN CORRECTION, and the one shape rule 19's mechanisms cannot carry. `mutateSessionMeta` opens the write funnel over `SessionRepository.write`; when the ledger commit inside `persistDraftUnlocked` throws, the catch calls `session.restoreDurableState`, and `TerminalSession.restoreState` re-announces the restored grid to the ATTACHED CLIENTS — repository.ts:658 -> session.ts:933 -> terminal.ts:1196 -> announceGeometry -> broadcast -> `ClientConn.send`. Verified BY ABLATION rather than by reading: delete the `announceGeometry()` call at terminal.ts:1209 and this finding is the only one that disappears, so that arrival is the sole way this span reaches a socket at all. Rule 19 asks whether anything outside the process would be wrong for having seen this if the transaction rolled back. It rolled back — that is the precondition of this code running — and what the clients are told is the state the rollback restored, which is what they will still be looking at afterwards. Deferring it would not move it, it would DELETE it: afterCommit/postCommit run a step when the span COMMITS, and this span does not. The comment at terminal.ts:1201 already draws the other half of the line and it holds here: clients only, no `resize` to the daemon, because the rollback undoes what the SERVER believed about geometry while the pty never moved.",
  },
  {
    key: 'packages/sync/src/authority/ports.ts#ChangeSubscriber.ChangeSubscriber@packages/sync/src/authority/authority.ts:247',
    why: "THE SAME BRANCH, from the Authority's OWN span rather than through the attach orchestrator's — `deps.transact` at authority.ts:247, finalize at :526, broadcast at :598, `subscription.deliver` at :607. Adjudicated against ledger §A row 3 and it stands for the reason the row itself gives: `AuthorityDeps.postCommit` is OPTIONAL, and unset MEANS immediate because that is what every client adapter and every unit test wants. relay.ts is what sets it in the server, so the immediate arm is unreachable there — a wiring fact, which is exactly the kind of fact a type checker cannot have. Making the arm unreachable in the type system would mean making the port required, which row 3 rules out in as many words. Two rows for one code path is not duplication: an ACCEPTED key names a capability AND the span root that reaches it, so the second root has to be adjudicated on its own or it reads as a new finding, which is what it did at the tip [POD-3518].",
  },
]

interface Options {
  readonly json: boolean
  readonly report: boolean
}

function parseArgs(argv: readonly string[]): Options {
  return { json: argv.includes('--json'), report: argv.includes('--report') }
}

function keyOf(finding: SpanFinding): string {
  return `${finding.capability.key}@${finding.root.site.file}:${finding.root.site.line}`
}

interface Verdict {
  readonly failures: readonly string[]
  readonly accepted: readonly SpanFinding[]
  readonly fresh: readonly SpanFinding[]
  readonly slack: readonly string[]
}

/** The gate, over an analysis result. Pure, so the fixture suite can drive it. */
export function judge(result: AnalysisResult, accepted: readonly AcceptedFinding[]): Verdict {
  const known = new Set(accepted.map((entry) => entry.key))
  const seen = new Set<string>()
  const fresh: SpanFinding[] = []
  const matched: SpanFinding[] = []
  for (const finding of result.findings) {
    const key = keyOf(finding)
    seen.add(key)
    if (known.has(key)) matched.push(finding)
    else fresh.push(finding)
  }
  const slack = accepted.filter((entry) => !seen.has(entry.key)).map((entry) => entry.key)

  const failures: string[] = []
  for (const finding of fresh) {
    failures.push(
      `NEW observable effect inside a span: ${finding.capability.what}\n` +
        `    span    ${finding.root.opener} at ${finding.root.site.file}:${finding.root.site.line} (${finding.root.enclosing})\n` +
        `    reached ${finding.path.map((site) => `${site.file}:${site.line}`).join('\n            ')}\n` +
        '    Move it to a post-commit mechanism (afterCommit / postCommit), or, if a rollback\n' +
        '    would leave nothing outside this process wrong, classify the callee in\n' +
        '    PORT_CAPABILITIES with the sentence that says why (spec §6 rule 19).',
    )
  }
  for (const [key, roots] of result.unclassified) {
    failures.push(
      `UNCLASSIFIED port member: ${key}\n` +
        `    reached from ${roots.length} span ${roots.length === 1 ? 'body' : 'bodies'}, first at ` +
        `${roots[0]?.site.file}:${roots[0]?.site.line}\n` +
        '    Add it to PORT_CAPABILITIES in scripts/span-effect-graph.ts with its kind and\n' +
        "    the one sentence that answers rule 19's question for it.",
    )
  }
  for (const key of slack) {
    failures.push(
      `SLACK in the accepted list: ${key}\n` +
        '    No finding matches it any more — the site was fixed, or the span moved.\n' +
        '    Delete the line from ACCEPTED in scripts/check-span-effects.ts.',
    )
  }
  for (const opener of result.deadOpeners) {
    failures.push(
      `DEAD span opener: ${opener}\n` +
        '    SPAN_OPENERS names it and nothing in the program resolves to it. Either it was\n' +
        '    renamed — in which case this lint has been scanning fewer spans than it says —\n' +
        '    or it is gone and the entry should go with it.',
    )
  }
  for (const site of result.uncoveredOpeners) {
    failures.push(
      `UNNAMED transaction opener: ${site.file}:${site.line}\n` +
        '    A `transact`/`transaction` declaration that is in neither SPAN_OPENERS nor\n' +
        '    NOT_A_SPAN_OPENER. Say which it is, in scripts/span-effect-graph.ts.',
    )
  }
  for (const site of result.staleExemptions) {
    failures.push(
      `STALE not-an-opener pin: ${site.file}:${site.line}\n` +
        '    NOT_A_SPAN_OPENER pins a declaration at that line and there is none there any\n' +
        '    more. The row excuses nothing while still reading as an answer, which is how\n' +
        '    two executor pins went on standing after POD-3802 moved both declarations —\n' +
        '    only the NEW line was reported. Re-point the line, or delete the row with the\n' +
        '    declaration it was about.',
    )
  }
  return { failures, accepted: matched, fresh, slack }
}

function report(result: AnalysisResult, verdict: Verdict): void {
  const byOpener = new Map<string, number>()
  for (const root of result.roots) byOpener.set(root.opener, (byOpener.get(root.opener) ?? 0) + 1)
  console.log('span bodies, by opener:')
  for (const [opener, count] of [...byOpener].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${opener}`)
  }
  console.log(`\n  ${result.roots.length} span bodies analysed`)
  console.log(`  ${verdict.accepted.length} observable effects, all on the accepted list`)
  console.log(`  ${result.unclassified.size} unclassified port members`)
  const blind = result.opaqueRoots.filter((root) => !root.forwarded)
  const forwarders = result.opaqueRoots.filter((root) => root.forwarded)
  console.log(`  ${blind.length} span bodies the rule cannot see inside:`)
  for (const root of blind) {
    console.log(`      ${root.site.file}:${root.site.line} — ${root.opener} in ${root.enclosing}`)
  }
  console.log(
    `  ${forwarders.length} span bodies handed in as a parameter — analysed at the call site that` +
      ' writes the function down, NOT followed where the caller picks it at runtime:',
  )
  for (const root of forwarders) {
    console.log(`      ${root.site.file}:${root.site.line} — ${root.opener} in ${root.enclosing}`)
  }
  const reachableBlind = result.blindSpots.reduce((total, entry) => total + entry.calls, 0)
  console.log(
    `  ${result.unresolvedCalls} calls the checker gave no signature for in the whole scan; ` +
      `${reachableBlind} of them reachable from a span body:`,
  )
  for (const entry of result.blindSpots.slice(0, 10)) {
    console.log(`      ${String(entry.calls).padStart(4)}  ${entry.file}`)
  }
}

/**
 * THE REPOSITORY, not the working directory. Every path this lint reports, every
 * key in {@link ACCEPTED} and every key in `PORT_CAPABILITIES` is repo-relative,
 * so the root has to be the repository whatever directory the process was
 * started in — and once it goes through a turbo task it is started in
 * `scripts/`, not the root.
 */
const REPO_ROOT = resolve(import.meta.dirname, '..')

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  const repoRoot = REPO_ROOT
  const program = createProjectProgram(repoRoot, 'apps/server/tsconfig.json')
  const result = analyze(program, { repoRoot, roots: ROOT_SCOPE, walk: WALK_SCOPE })
  const verdict = judge(result, ACCEPTED)

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          roots: result.roots.length,
          findings: result.findings.map((finding) => ({
            key: keyOf(finding),
            capability: finding.capability,
            span: finding.root,
            path: finding.path,
          })),
          unclassified: [...result.unclassified.keys()],
          opaqueRoots: result.opaqueRoots,
          unresolvedCalls: result.unresolvedCalls,
          failures: verdict.failures,
        },
        null,
        2,
      ),
    )
    process.exit(verdict.failures.length === 0 ? 0 : 1)
  }

  if (options.report) report(result, verdict)

  if (verdict.failures.length === 0) {
    console.log(
      `span-effect lint: ${result.roots.length} span bodies, ${verdict.accepted.length} accepted observable effects, ` +
        `${result.unclassified.size} unclassified, ${result.opaqueRoots.length} opaque bodies. OK.`,
    )
    console.log(
      `  (what it cannot see is listed, not assumed away: run with --report, and read ` +
        `${relative(repoRoot, `${repoRoot}/docs/gates/pod-3332-span-effect-lint.md`)})`,
    )
    return
  }

  console.error(`span-effect lint: ${verdict.failures.length} failure(s)\n`)
  for (const failure of verdict.failures) console.error(`  ${failure}\n`)
  process.exit(1)
}

if (import.meta.main) main()

export { ACCEPTED, keyOf, ROOT_SCOPE, WALK_SCOPE }
