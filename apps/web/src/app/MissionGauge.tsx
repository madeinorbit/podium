import type { MissionProgress } from '@podium/client-core/values'
import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { observer } from '@podium/client-graph/react'
import type { JSX } from 'react'

// The counts span the header; the wordless bar shares the row with cost and Add agent.
type MissionGaugeProps = {
  working?: number
  live?: number
} & ({ full: FullDeck; progress?: never } | { full?: never; progress: MissionProgress })

export const MissionGauge = observer(function MissionGauge({
  progress,
  full,
  working = 0,
}: MissionGaugeProps): JSX.Element {
  const computing = full ? full.computing : working > 0
  const counts = full ? full.buckets : progress!
  const { total, done } = counts
  const bands = [
    ['done', 'done', done],
    ['working', 'working', counts.working],
    ['waiting', 'waiting', counts.waiting],
    ['todo', 'to do', counts.todo],
  ] as const
  const reading = `${done} of ${total} tasks done, ${bands
    .slice(1)
    .map(([, word, count]) => `${count} ${word}`)
    .join(', ')}`
  return (
    <div className="mission-gauge" data-testid="mission-gauge" data-working={computing}>
      <div className="mission-gauge-counts" data-testid="mission-gauge-counts">
        {bands.filter(([, , count]) => count > 0).map(([state, word, count]) => (
          <span key={state} className="mission-gauge-key">
            <i className="mission-gauge-swatch" data-s={state} aria-hidden="true" />
            <span>
              <b>{count}</b> {word}
            </span>
          </span>
        ))}
      </div>
      <div className="mission-gauge-bar" role="img" aria-label={reading} title={reading}>
        <span className="mission-gauge-track" data-testid="mission-gauge-track" aria-hidden="true">
          {bands
            .filter(([, , count]) => count > 0)
            .map(([state, , count]) => (
              <span
                key={state}
                className="mission-gauge-segment"
                data-testid="mission-gauge-band"
                data-s={state}
                data-working={state === 'working' && computing}
                style={{ flexGrow: count }}
              />
            ))}
        </span>
      </div>
    </div>
  )
})
