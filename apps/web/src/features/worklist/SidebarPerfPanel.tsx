import {
  bindSidebarPerf,
  createSidebarPerf,
  type SidebarPerf,
  type SidebarPerfSnapshot,
} from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { JSX } from 'react'
import { useLayoutEffect, useState } from 'react'
import {
  bindSidebarRowMeasurements,
  createPaintBoundary,
  observeSidebarInputs,
} from './sidebar-measurements'

const ms = (value: number | null): string =>
  value === null ? '—' : `${value === 0 ? '0' : value.toFixed(1)} ms`

/** Testable readout. Receives only plain counter reports; no data-layer reader. */
export function SidebarPerfReadout({
  report,
  heap,
  onClose,
}: {
  report: SidebarPerfSnapshot
  heap: number | null
  onClose: () => void
}): JSX.Element {
  const { idle, input, lastUpdate } = report
  return (
    <aside
      data-perf-panel
      data-testid="sidebar-perf-panel"
      aria-label="Sidebar performance"
      className="fixed right-3 bottom-3 z-[80] w-80 max-w-[calc(100vw-24px)] rounded-lg border border-border bg-background/95 p-3 text-[11px] text-foreground shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between">
        <strong>
          Sidebar performance · {report.pool.connected ? 'Pool' : 'Pool not connected'}
        </strong>
        <button
          type="button"
          data-pressable
          onClick={onClose}
          aria-label="Close performance panel"
          className="px-1 text-muted-foreground"
        >
          ×
        </button>
      </div>
      <div className="space-y-2 tabular-nums">
        <section>
          <div className="text-muted-foreground">
            Idle work · last 60 s
            {report.windowMs < 60_000 ? ` (observed ${Math.floor(report.windowMs / 1000)} s)` : ''}
          </div>
          <div data-testid="perf-idle">
            {!report.pool.connected ? (
              'Waiting for pool counters'
            ) : (
              <>
                {report.complete ? '' : 'At least '}
                {idle.rows} rows redrawn · {idle.derivations} derivations · {ms(idle.mainThreadMs)}
              </>
            )}
          </div>
        </section>
        <section>
          <div className="text-muted-foreground">Last incoming update</div>
          <div data-testid="perf-update">
            {lastUpdate
              ? `${lastUpdate.changed.join(', ')}${lastUpdate.pending ? ' · settling' : ''}`
              : 'Waiting for an update'}
          </div>
          {lastUpdate && (
            <div>
              {lastUpdate.work.rows} rows redrawn · {ms(lastUpdate.work.mainThreadMs)}
            </div>
          )}
        </section>
        <section>
          <div className="text-muted-foreground">Sidebar input → next paint</div>
          <div data-testid="perf-input">
            Last {ms(input.lastMs)} · p50 {ms(input.p50)} · p95 {ms(input.p95)} · {input.count}{' '}
            inputs
          </div>
        </section>
        <div data-testid="perf-memory">
          JS heap {heap === null ? 'unavailable' : `${(heap / 1048576).toFixed(1)} MB`} · Pool rows{' '}
          {report.pool.rows ?? 'not connected'}
        </div>
      </div>
    </aside>
  )
}

export function SidebarPerfPanel(): JSX.Element | null {
  return <OpenSidebarPerfPanel />
}
function OpenSidebarPerfPanel(): JSX.Element | null {
  const owner = useStoreHandle()
  const [closed, close] = useState(false)
  return closed ? null : <SidebarPerfSession owner={owner} onClose={() => close(true)} />
}
export function SidebarPerfSession({
  owner,
  onClose,
}: {
  owner: object
  onClose: () => void
}): JSX.Element {
  const [perf] = useState(() => createSidebarPerf())
  const [report, setReport] = useState(() => perf.read())
  const [heap, setHeap] = useState<number | null>(null)
  useLayoutEffect(() => {
    // A principal/runtime rebuild resets every retained counter and input sample.
    perf.reset()
    const paint = createPaintBoundary()
    const unbind = bindSidebarPerf(owner, perf, paint.afterPaint)
    const unbindRows = bindSidebarRowMeasurements({ owner, perf })
    const stopInput = observeSidebarInputs(perf, paint.afterPaint)
    const api = { read: () => perf.read() }
    globalThis.__podiumSidebarPerf = api
    const sample = (): void => {
      setReport(perf.read())
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
      setHeap(memory?.usedJSHeapSize ?? null)
    }
    sample()
    const interval = setInterval(sample, 1000)
    return () => {
      clearInterval(interval)
      stopInput()
      paint.dispose()
      unbindRows()
      unbind()
      if (globalThis.__podiumSidebarPerf === api) delete globalThis.__podiumSidebarPerf
    }
  }, [owner, perf])
  return <SidebarPerfReadout report={report} heap={heap} onClose={onClose} />
}
declare global {
  var __podiumSidebarPerf: { read(): ReturnType<SidebarPerf['read']> } | undefined
}
