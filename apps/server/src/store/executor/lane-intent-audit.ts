import { appendFileSync } from 'node:fs'
import { IntentAudit } from './intent-audit'
import type { StatementProbeHub } from './statement-probe'

/**
 * THE LANE'S DECLARED-INTENT AUDIT [POD-3391].
 *
 * ONE audit for the whole process, not one per harness, because the gate's
 * question is about a LANE — "did any statement this lane executed declare a
 * write as a read" — and a per-harness object would have to be collected from
 * every test that forgot to close one. Harnesses and repository test seams feed it; nothing reads it
 * except the gate below and a test that asks.
 *
 * Harnesses and stageASeam attach unconditionally. The production composition
 * root attaches only when PODIUM_STATEMENT_INTENT_REPORT is requested, covering
 * repository tests that construct through createBunStoreExecutor or SessionStore
 * without adding audit work to ordinary production executions.
 */
const laneAudit = new IntentAudit()

/** What every harness and repository test seam in this process saw. */
export function laneIntentAudit(): IntentAudit {
  return laneAudit
}

/** Attach once per connection hub, even when several repositories share it. */
const laneAuditHubs = new WeakSet<StatementProbeHub>()

export function attachLaneIntentAudit(hub: StatementProbeHub): void {
  if (laneAuditHubs.has(hub)) return
  hub.attach(laneAudit.probe, { wantsIssueSite: true })
  laneAuditHubs.add(hub)
}

/**
 * Append this process's audit to the gate's report, if one was asked for.
 *
 * JSONL AND APPEND-ONLY because vitest runs the lane across several workers and
 * each is its own process: the gate sums the lines. Registered on `exit` rather
 * than in an `afterAll`, so a worker that ran no store test still contributes
 * its (empty) line and a worker that crashed contributes nothing — which
 * under-reports the count, the safe direction for a check whose failure mode is
 * a vacuous pass.
 */
const intentReportPath = process.env.PODIUM_STATEMENT_INTENT_REPORT
if (intentReportPath) {
  process.on('exit', () => {
    try {
      appendFileSync(
        intentReportPath,
        `${JSON.stringify({ totals: laneAudit.totals, reach: laneAudit.reach, findings: laneAudit.findings })}\n`,
      )
    } catch {
      // A report that cannot be written must not fail the test that produced
      // it; the gate notices a missing line as a missing count, which is the
      // observation it is built to make.
    }
  })
}
