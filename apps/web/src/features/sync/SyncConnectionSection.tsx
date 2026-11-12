import type { ConnectionCondition } from '@podium/client-core/live'
import type { JSX } from 'react'
import { connectionSeverity, describeHealth } from '@/features/machines/ConnectionIndicator'
import { useClock } from '@/lib/clock-hooks'

/**
 * The sync panel's connection section (POD-6852). It replaced the connection
 * glyph, so it also took over the glyph's clock: one shared one-second clock
 * while the link is unhealthy, none while it is fine.
 */
export function SyncConnectionSection({
  health,
  onDetails,
}: {
  health: ConnectionCondition
  onDetails?: () => void
}): JSX.Element {
  const severity = connectionSeverity(health)
  const now = useClock(1_000, severity !== 'ok')
  const { headline, detail } = describeHealth(health, now)
  return (
    <section className="sync-panel-sec" aria-label="Connection">
      <h3 className="sync-panel-lab" data-tone={severity === 'down' ? 'bad' : 'warn'}>
        Connection
      </h3>
      <p data-testid="sync-connection-line">
        <strong>{headline}.</strong> {detail}
      </p>
      <button type="button" data-pressable className="sync-panel-link" onClick={onDetails}>
        Connection details
      </button>
    </section>
  )
}
