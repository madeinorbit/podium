import type { ServerMessage } from '@podium/protocol'
import type { PublishSpec } from '../../funnel'
import type { IssueDeps } from './types'

/**
 * TEST-ONLY funnel/publish plumbing for IssueDeps (issue #190): a minimal
 * in-memory IssueFunnel (authorize → write → publish, no oplog) plus the two
 * issue PublishSpec builders WITHOUT the upstream-mirror union, forwarding
 * every published snapshot to `broadcast` — the message stream service tests
 * asserted on back when IssueDeps carried a raw `broadcast(msg)` hook.
 * Production wiring lives in relay.ts (WriteFunnel + IssuePublisher).
 */
export function issueTestPlumbing(
  broadcast: (msg: ServerMessage) => void = () => {},
): Pick<IssueDeps, 'funnel' | 'publishSpecs'> {
  const publishSpec = (spec: PublishSpec): void => broadcast(spec.snapshot)
  return {
    funnel: {
      run: (op) => {
        op.authorize?.()
        const result = op.write()
        const spec = op.publish?.(result)
        if (spec) publishSpec(spec)
        return result
      },
      publishSpec,
    },
    publishSpecs: {
      issueUpdated: (issue) => ({
        entity: 'issue',
        rows: [{ id: issue.id, value: issue }],
        snapshot: { type: 'issueUpdated', issue },
        partial: true,
      }),
      issuesChanged: (issues) => ({
        entity: 'issue',
        rows: issues.map((i) => ({ id: i.id, value: i })),
        snapshot: { type: 'issuesChanged', issues },
      }),
    },
  }
}
