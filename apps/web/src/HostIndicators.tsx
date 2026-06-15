import { MemoryStick } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { ConnectionIndicator, describeHealth, useStableConnection } from './ConnectionIndicator'
import { hostMemoryView } from './derive'
import { type HostInfoTab, HostInfoView } from './HostMemoryView'
import { useStore } from './store'

/**
 * Host health strip. Just two glyphs: a memory icon with a fullness bar (one per
 * daemon machine) and — only while the link is degraded or down — the connection
 * icon beside it. An always-green connection icon and a running GB readout are
 * both noise; the bar conveys pressure at a glance and a click opens the numbers.
 *
 * `compact` (mobile header) drops the bar, leaving the severity-colored icon —
 * header pixels belong to session selection there. Tapping either still opens
 * the per-process breakdown / connection detail.
 */
export function HostIndicators({ compact = false }: { compact?: boolean }): JSX.Element {
  const { hostMetrics } = useStore()
  const { health, visible: connVisible } = useStableConnection()
  const [infoTab, setInfoTab] = useState<HostInfoTab | null>(null)
  const showHostname = !compact && hostMetrics.length > 1
  // The visible icon only shows the detail on hover; a persistent polite live
  // region announces degraded/down transitions to assistive tech (empty while
  // healthy, so recovery isn't announced as noise). HostIndicators re-renders
  // only on health change, so the message isn't re-announced every second.
  const announce =
    health.status === 'ok'
      ? ''
      : (() => {
          const d = describeHealth(health, Date.now())
          return `${d.headline}. ${d.detail}`
        })()
  return (
    <div className="host-indicators">
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
      {hostMetrics.map((host) => {
        const mem = hostMemoryView(host)
        return (
          <button
            type="button"
            key={host.hostname}
            className={`host-chip mem-${mem.severity}${compact ? ' host-chip-compact' : ''}`}
            title={`${mem.title} — click for the breakdown`}
            onClick={() => setInfoTab('memory')}
          >
            {showHostname && <span className="host-chip-name">{host.hostname}</span>}
            <MemoryStick size={14} aria-hidden="true" />
            {!compact && (
              <span className="host-chip-bar" role="presentation">
                <span className="host-chip-fill" style={{ width: `${mem.pct}%` }} />
              </span>
            )}
          </button>
        )
      })}
      {connVisible && (
        <ConnectionIndicator health={health} onOpen={() => setInfoTab('connection')} />
      )}
      {infoTab && <HostInfoView initialTab={infoTab} onClose={() => setInfoTab(null)} />}
    </div>
  )
}
