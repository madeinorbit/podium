import { omitGone } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph/pool'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { lazy } from '@podium/mobx-helpers'
import type { AutomationId } from '@podium/model'
import { compareShallow } from 'mobx'
import { formatAppError } from '@/app/AppErrorPage'
import type { AutomationRun } from './AutomationsView'

/** The newest runs one open history section shows. */
export const AUTOMATION_HISTORY_LIMIT = 20

export type AutomationRunsQuery = (input: {
  automationId: AutomationId
  limit: number
}) => Promise<readonly { id: string }[]>

/** One open "Recent runs" section: on request, the server's newest run window
 * for this automation, newest first. The answer keeps IDs only; each run's
 * fields come from the shared automationRun models already fed by sync. */
export class AutomationHistory extends RequestAnswer<readonly string[]> {
  constructor(
    readonly automationId: AutomationId,
    private readonly query: AutomationRunsQuery,
    private readonly pool: MobxPool | null,
  ) {
    super((cause) => formatAppError(cause, 'Could not load runs'))
  }

  refresh = (): Promise<void> =>
    this.load(
      () => this.query({ automationId: this.automationId, limit: AUTOMATION_HISTORY_LIMIT }),
      false,
      (runs) => runs.map((run) => run.id),
    )

  /** Shown runs in answer order; a run the source no longer holds is gone. */
  @lazy({ equals: compareShallow }) get runs(): AutomationRun[] {
    const runs: AutomationRun[] = []
    if (!this.pool) return runs
    for (const id of this.answer ?? []) {
      const run = omitGone(this.pool.row('automationRun', id))
      if (run && run !== LOADING) runs.push(run)
    }
    return runs
  }

  /** No answer yet, or an answered run still on its way from the run source. */
  @lazy get pending(): boolean {
    if (this.answer === undefined) return !this.error
    if (!this.pool) return true
    return this.answer.some((id) => omitGone(this.pool!.row('automationRun', id)) === LOADING)
  }
}
