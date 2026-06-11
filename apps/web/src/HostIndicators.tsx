import type { JSX } from 'react'
import { useState } from 'react'
import { ConnectionIndicator, useConnectionHealth } from './ConnectionIndicator'
import { hostMemoryView } from './derive'
import { HostMemoryView } from './HostMemoryView'
import { useStore } from './store'

/**
 * Host health strip — the connection dot when the server link is unhealthy, plus
 * one chip per daemon machine; nothing at all when every signal is good (an
 * absent indicator beats a stale one). Clicking the memory chip opens the
 * per-process breakdown view.
 */
export function HostIndicators(): JSX.Element | null {
  const { hostMetrics } = useStore()
  const health = useConnectionHealth()
  const [open, setOpen] = useState(false)
  if (hostMetrics.length === 0 && health.status === 'ok') return null
  const showHostname = hostMetrics.length > 1
  return (
    <div className="host-indicators">
      <ConnectionIndicator health={health} />
      {hostMetrics.map((host) => {
        const mem = hostMemoryView(host)
        return (
          <button
            type="button"
            key={host.hostname}
            className={`host-chip mem-${mem.severity}`}
            title={`${mem.title} — click for the breakdown`}
            onClick={() => setOpen(true)}
          >
            {showHostname && <span className="host-chip-name">{host.hostname}</span>}
            <span className="host-chip-label">MEM {mem.label}</span>
            <span className="host-chip-bar" role="presentation">
              <span className="host-chip-fill" style={{ width: `${mem.pct}%` }} />
            </span>
          </button>
        )
      })}
      {open && <HostMemoryView onClose={() => setOpen(false)} />}
    </div>
  )
}
