/**
 * THE MACHINE-LOAD PANEL, PHOTOGRAPHED (POD-1603).
 *
 * The shipping `LoadPanel` inside the popover shell it opens in, against the
 * real stylesheet. The unit suite can prove the DISK row carries the right
 * number and that a re-opened panel does not re-walk the daemon; it cannot show
 * that the three meters line up in their grid, that the still slots stand in for
 * the rows at the rows' own rhythm, or that the refresh control sits on the
 * hostname's baseline without competing with it — all of which is CSS jsdom
 * never applies.
 *
 * One panel per page load, because the stub reads its query once at import:
 *
 *   ?state=settled   the whole breakdown, first gesture, nothing behind a click
 *   ?state=cold      the walk held open — the still slots beside what they
 *                    become, and the DISK row holding its place empty
 *   ?state=nodisk    a daemon that reports no disk sample, which the row says
 *                    rather than drawing as an empty volume
 *
 * `?theme=light` takes the Paper variant. The stub store reads `?delay=` and
 * `?disk=`; `state` is sugar that sets both.
 */
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { LoadPanel } from '@/features/machines/LoadPanel'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)

const root = document.documentElement
root.setAttribute('data-theme', 'podium')
root.classList.toggle('dark', params.get('theme') !== 'light')

function Panel(): JSX.Element {
  return (
    <div className="health-popover health-popover-machine">
      <LoadPanel
        machineId={'vmi34' as never}
        onOpenConnection={() => {}}
        onOpenReclaim={() => {}}
      />
    </div>
  )
}

const mount = document.getElementById('root')
if (mount) createRoot(mount).render(<Panel />)
