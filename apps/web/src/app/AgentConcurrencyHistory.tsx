import { observer } from 'mobx-react-lite'
import { Popover } from '@base-ui/react/popover'
import { type JSX, useMemo, useState } from 'react'
import { usePoolConcurrencyHistory, usePoolWorkingSessionIds, usePoolHeaderSession } from './header-data'
import { StatusMetric } from './StatusMetric'
import { shareAgentConcurrency } from './status-share'

const BUCKETS = 24
const DEFAULT_BUCKET_MS = 30 * 60 * 1_000

/**
 * The status strip's 71×12px history skyline. It is deliberately informational:
 * hover/focus reveals precision, and its one adjacent action shares the current
 * reading rather than changing the instrument.
 */
export function AgentConcurrencyHistory({ working }: { working: number }): JSX.Element {
  const [rosterOpen, setRosterOpen] = useState(false)
  const history = usePoolConcurrencyHistory()

  const buckets = useMemo(() => {
    const next =
      history?.buckets.map((bucket) => ({ ...bucket })) ??
      Array.from({ length: BUCKETS }, () => ({ start: '', count: 0 }))
    // Before the first history response, the live count still draws the current
    // stack. Once loaded, the server's half-hour peak is intentionally allowed
    // to sit above the exact current sentence beside it.
    if (!history) next[BUCKETS - 1] = { start: '', count: working }
    return next
  }, [history, working])
  const peak = Math.max(history?.peak ?? 0, ...buckets.map((bucket) => bucket.count))
  const ariaLabel = `Agent concurrency over the last 12 hours. ${working} ${working === 1 ? 'agent' : 'agents'} working now. Peak ${peak}.`

  return (
    <StatusMetric
      testId="agent-concurrency-history"
      tone="agents"
      current={
        working > 0 ? (
          <Popover.Root open={rosterOpen} onOpenChange={setRosterOpen}>
            <Popover.Trigger
              className="status-strip-live status-strip-roster-trigger"
              data-testid="status-strip-working"
              aria-label={`${working} ${working === 1 ? 'agent' : 'agents'} working. Show agents`}
            >
              <span className="status-strip-spinner" aria-hidden="true" />
              {working} {working === 1 ? 'agent' : 'agents'} working
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner side="top" align="start" sideOffset={7} className="isolate z-50">
                <Popover.Popup className="status-strip-roster" data-testid="status-strip-roster">
                  <Popover.Title className="status-strip-roster-title">
                    Agents working now
                  </Popover.Title>
                  {rosterOpen && <WorkingRoster />}
                  <p>Connected sessions with activity in the last 15 minutes.</p>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        ) : (
          <span className="status-strip-idle" data-testid="status-strip-working">
            no agents working
          </span>
        )
      }
      buckets={buckets.map((bucket) => ({
        startMs: Date.parse(bucket.start) || 0,
        value: bucket.count,
      }))}
      title="Agent concurrency"
      summary={ariaLabel}
      aside={`peak ${peak}`}
      reading={(value) => ({
        value: String(value),
        label: value === 1 ? 'agent at peak' : 'agents at peak',
      })}
      foot="Last 12 hours · 30-minute peaks"
      bucketMs={history?.bucketMs ?? DEFAULT_BUCKET_MS}
      shareText={shareAgentConcurrency(working)}
    />
  )
}

function WorkingRoster() {
  const ids = usePoolWorkingSessionIds()
  return (
    <ul className="status-strip-roster-list">
      {ids.map(id => <WorkingSessionRow key={id} id={id} />)}
    </ul>
  )
}

const WorkingSessionRow = observer(function WorkingSessionRow({ id }: { id: string }) {
  const header = usePoolHeaderSession(id)
  if (!header) return null
  return (
    <li>
      <span>{header.name ?? header.title}</span>
      <b>{header.displayRef ?? header.agentKind}</b>
    </li>
  )
})
