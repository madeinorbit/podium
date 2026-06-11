import type { JSX } from 'react'
import { useState } from 'react'
import { hostMemoryView } from './derive'
import { HostMemoryView } from './HostMemoryView'
import { useStore } from './store'

/**
 * Host health strip — one chip per daemon machine, nothing when no daemon is
 * reporting (an absent indicator beats a stale one). Currently memory; siblings
 * (connection stability, …) will join this strip. Clicking the memory chip opens
 * the per-process breakdown view.
 */
export function HostIndicators(): JSX.Element | null {
  const { hostMetrics } = useStore()
  const [open, setOpen] = useState(false)
  if (hostMetrics.length === 0) return null
  const showHostname = hostMetrics.length > 1
  return (
    <div className="host-indicators">
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
