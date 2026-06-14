import { MemoryStick } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { ConnectionIndicator, describeHealth, useStableConnection } from './ConnectionIndicator'
import { hostMemoryView } from './derive'
import { type HostInfoTab, HostInfoView } from './HostMemoryView'
import { useStore } from './store'
import { UsageChip } from './UsageView'

/**
 * Host health strip. The connection indicator appears only while the link is
 * degraded or down — an always-green icon is noise, and the problem states are
 * what need attention. One memory chip per daemon machine; clicking it opens
 * the per-process breakdown view.
 *
 * `compact` (mobile header) shrinks everything to icons: a severity-colored
 * memory icon instead of the label+bar chip, and no usage chip — header pixels
 * belong to session selection there. Tapping an icon still opens the detail.
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
      {connVisible && (
        <ConnectionIndicator health={health} onOpen={() => setInfoTab('connection')} />
      )}
      {!compact && <UsageChip />}
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
            {compact ? (
              <MemoryStick size={14} aria-hidden="true" />
            ) : (
              <>
                {showHostname && <span className="host-chip-name">{host.hostname}</span>}
                <span className="host-chip-label">MEM {mem.label}</span>
                <span className="host-chip-bar" role="presentation">
                  <span className="host-chip-fill" style={{ width: `${mem.pct}%` }} />
                </span>
              </>
            )}
          </button>
        )
      })}
      {infoTab && <HostInfoView initialTab={infoTab} onClose={() => setInfoTab(null)} />}
    </div>
  )
}
