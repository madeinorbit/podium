import { shallowEqual } from '@podium/client-core/store'
import {
  DEFAULT_LOAD_PER_CORE,
  formatMemBytes,
  hostDiskView,
  hostLoadView,
  hostMemoryView,
  idleSessionSplit,
  panelLabel,
  reclaimSpaceLabel,
  residencyBreakdown,
} from '@podium/client-core/viewmodels'
import type { MachineId, SessionId } from '@podium/model/browser'
import { RotateCw } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useStoreSelector } from '@/app/store'
import type { Trpc } from '@/app/trpc'
import { usePolledQuery } from '@/lib/use-polled-query'
import { cn } from '@/lib/utils'
import { HealthPopoverFooter } from './HealthPopover'
import { useHostLifecycleSettings } from './host-lifecycle-settings'
import { SEVERITY, TONE_KEY } from './severity'
import { useReclaimInventory } from './use-reclaim-inventory'

/** The daemon's answer, minus the wire plumbing the server already stripped. */
type Breakdown = Awaited<ReturnType<Trpc['hosts']['memoryBreakdown']['mutate']>>

/**
 * How long a walk stays worth trusting when the panel is OPENED.
 *
 * The width of a glance loop: long enough that closing the panel and opening it
 * again to re-read a row costs nothing, short enough that a number you are
 * watching move — an agent starting, a build filling the box — is never stale in
 * a way that could mislead.
 *
 * It is deliberately NOT the open panel's cadence, which stays at the 5s it has
 * always run at. The two answer different questions: while you are looking, keep
 * the figures live; when you open it again a moment later, do not make a machine
 * re-walk `/proc` to tell you what it just told you. Only the second was ever a
 * problem — a panel that is open is a panel someone is reading.
 */
const FRESH_MS = 20_000

/** The open panel's own cadence, unchanged since the modal this replaced. */
const REFRESH_MS = 5_000

/**
 * The machine-load panel: everything this host is spending, in one tier.
 *
 * It opens on hover from the header chip and shows the WHOLE breakdown at once —
 * the three pressure meters, what is eating the memory, the per-session and
 * per-project rows, reclaimable inventory, hibernation + worktree-GC status, and
 * a footer jump to connection detail. It used to hold half of that behind a
 * second click ("click to pin breakdown"): a zoom rung that made the panel's own
 * height a surprise, hid the process list from anyone who only ever hovered, and
 * asked the operator to discover a mode before they could read a number. The
 * panel is a readout; a readout does not have modes.
 *
 * The `/proc` walk behind it runs through the one polling utility, and the panel
 * is why that utility learned `freshForMs`: this is a HOVER surface on a header
 * chip, so sweeping the pointer across the top bar used to place a full process
 * walk on a daemon per pass, and every re-open threw the previous answer away to
 * redraw a loading state over numbers that were two seconds old. An open panel
 * still refreshes every {@link REFRESH_MS}; a re-opened one inside
 * {@link FRESH_MS} asks the machine for nothing. The header's refresh control
 * overrides both; the footer stamps when what you are reading was taken.
 *
 * Reclaim inventory is server-authoritative (POD-2662) and arrives on its own
 * schedule: its hardlink-aware disk walk is backgrounded and polled until cached
 * bytes land, which is why that row says "Counting checkouts…" rather than
 * holding the panel.
 */
export function LoadPanel({
  machineId,
  updateNote,
  onOpenConnection,
  onOpenReclaim,
}: {
  machineId?: MachineId
  updateNote?: ReactNode
  onOpenConnection: () => void
  onOpenReclaim?: () => void
}): JSX.Element {
  const { trpc, sessions, hostMetrics, setView, setSettingsTab } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      sessions: s.sessions,
      hostMetrics: s.hostMetrics,
      setView: s.setView,
      setSettingsTab: s.setSettingsTab,
    }),
    shallowEqual,
  )
  const lifecycle = useHostLifecycleSettings()
  const hibernation = lifecycle?.hibernation ?? null
  const worktreeGc = lifecycle?.worktreeGc ?? null
  const { data, fetchedAt, pending, failed, error, refresh } = usePolledQuery<Breakdown>({
    // Everything the read depends on is in the key, or a chip click would paint
    // one machine's processes under another machine's hostname.
    key: `hosts.memoryBreakdown:${machineId ?? ''}`,
    intervalMs: REFRESH_MS,
    freshForMs: FRESH_MS,
    read: () => trpc.hosts.memoryBreakdown.mutate(machineId ? { machineId } : undefined),
  })

  // Instant headline from the streamed host metric; the breakdown fills in.
  const metric = hostMetrics.find((h) => h.machineId === machineId) ?? hostMetrics[0]
  const mem = data
    ? hostMemoryView({ hostname: data.hostname, sampledAt: data.sampledAt, memory: data.memory })
    : metric
      ? hostMemoryView(metric)
      : null
  const load = metric ? hostLoadView(metric, hibernation?.loadPerCore ?? null) : null
  // Disk rides on the breakdown, not on the 5s metrics heartbeat — one statfs is
  // cheap but the header chip has no disk bar to feed, so it is measured where
  // it is read. Until the walk answers the row is drawn empty rather than
  // withheld: appearing late would push the whole body down a line.
  const disk = data?.disk ? hostDiskView(data.disk) : null
  const idleSplit = idleSessionSplit(sessions, machineId)
  const { inventory: reclaimable } = useReclaimInventory(trpc, machineId)
  const reclaimCount = reclaimable?.candidates.length ?? 0
  const orphanCount = reclaimable?.orphans.length ?? 0
  const reclaimLabel = reclaimSpaceLabel(reclaimable?.estimate ?? null)

  const total = data?.memory.totalBytes ?? 0
  const agentBytes = data?.agents.reduce((sum, a) => sum + a.bytes, 0) ?? 0
  const projectBytes = data?.projects.reduce((sum, p) => sum + p.bytes, 0) ?? 0
  const seg = (bytes: number): string => `${total > 0 ? (bytes / total) * 100 : 0}%`

  const sessionLabel = (sessionId: SessionId): string => {
    const s = sessions.find((s) => s.sessionId === sessionId)
    if (!s) return sessionId.slice(0, 8)
    return `${panelLabel(s.agentKind)} — ${s.title}`
  }

  const memActive =
    hibernation?.enabled === true && mem !== null && mem.pct >= hibernation.memoryPct
  const loadActive =
    hibernation?.enabled === true &&
    hibernation.loadPerCore != null &&
    load?.perCore != null &&
    load.perCore >= hibernation.loadPerCore
  const hibActive = memActive || loadActive

  const openHibernation = (): void => {
    setSettingsTab('hibernation')
    setView('settings')
  }

  // The chip is two bare bars once the density hides its MEM/LOAD marks, and
  // their colour is severity, not identity — a healthy memory bar and a pegged
  // load bar differ only in hue. So the panel repeats both meters at the chip's
  // own width and fill and names them, and each carries the sentence the colour
  // was standing in for. DISK joins them here without a chip bar of its own:
  // this block is the host's pressure, and the two the chip can afford to carry
  // are a subset of it, not its definition.
  const loadThreshold = hibernation?.loadPerCore ?? DEFAULT_LOAD_PER_CORE
  const loadNote =
    load == null || load.perCore == null
      ? 'this host reports no load sample'
      : load.severity === 'critical'
        ? `per core — past the ${loadThreshold}× line`
        : `per core — bar fills at ${loadThreshold}×`
  const diskNote = disk
    ? `${disk.label} used · ${disk.freeLabel}`
    : data
      ? 'this host reports no disk sample'
      : 'reading the volume…'

  // What the removed native tooltip used to say, kept where it can sit beside
  // the memory it explains. The rows below list these sessions one by one; this
  // is the only place their working / idle / waiting split is stated.
  const phases = residencyBreakdown(sessions, machineId)
  const resident = phases.working + phases.idle + phases.waiting + phases.other
  const agentLine =
    resident > 0
      ? `${resident} agent${resident === 1 ? '' : 's'} here — ${phases.working} working, ${phases.idle} idle, ${phases.waiting} waiting on you`
      : null

  return (
    <>
      <div className="hp-header hp-header-stacked">
        <div className="hp-header-top">
          <span className="hp-title">{mem?.hostname ?? '…'}</span>
          {/* Re-measure now. It sits beside the hostname because it acts on the
              whole panel, and it is the only control in the header — the numbers
              under it are readouts and must not look pressable. */}
          <button
            data-pressable
            type="button"
            className="hp-refresh"
            data-busy={pending ? '' : undefined}
            onClick={refresh}
            disabled={pending}
            aria-label={pending ? 'Re-measuring this machine' : 'Re-measure this machine now'}
            title="Re-measure now"
          >
            <RotateCw size={11} aria-hidden="true" />
          </button>
        </div>
        <div className="hp-meters">
          {mem && (
            <div className="hp-meter-row">
              <span className="header-meter" role="presentation">
                <span
                  className={cn('block h-full', SEVERITY[mem.severity].fill)}
                  style={{ width: `${mem.pct}%` }}
                />
              </span>
              <span className="hp-meter-mark">MEM</span>
              <span className="hp-meter-value" data-tone={TONE_KEY[mem.severity]}>
                {mem.pct}%
              </span>
              <span className="hp-meter-note">{mem.label} used</span>
            </div>
          )}
          {load && (
            <div className="hp-meter-row">
              <span className="header-meter" role="presentation">
                <span
                  className={cn('block h-full', SEVERITY[load.severity].fill)}
                  style={{ width: `${load.meterPct}%` }}
                />
              </span>
              <span className="hp-meter-mark">LOAD</span>
              <span className="hp-meter-value" data-tone={TONE_KEY[load.severity]}>
                {load.label}
              </span>
              <span className="hp-meter-note">{loadNote}</span>
            </div>
          )}
          <div className="hp-meter-row">
            <span className="header-meter" role="presentation">
              {disk && (
                <span
                  className={cn('block h-full', SEVERITY[disk.severity].fill)}
                  style={{ width: `${disk.pct}%` }}
                />
              )}
            </span>
            <span className="hp-meter-mark">DISK</span>
            <span
              className="hp-meter-value"
              {...(disk ? { 'data-tone': TONE_KEY[disk.severity] } : {})}
            >
              {disk ? `${disk.pct}%` : '—'}
            </span>
            <span className="hp-meter-note" title={disk?.title}>
              {diskNote}
            </span>
          </div>
        </div>
      </div>
      {/* Everything between the hostname and the footer scrolls: the panel lists
          one row per session, so on a busy machine it is taller than the window
          (POD-751). The header stays so you never lose which host you are
          reading; the footer stays so the way out stays on screen. */}
      <div className="hp-scroll">
        <div className="hp-section">
          {data ? (
            <>
              <div className="hp-seg" role="presentation">
                <i className="hp-seg-agents" style={{ width: seg(agentBytes) }} />
                <i className="hp-seg-projects" style={{ width: seg(projectBytes) }} />
                <i className="hp-seg-other" style={{ width: seg(data.otherBytes) }} />
              </div>
              <div className="hp-legend">
                <span>
                  <i className="hp-seg-agents" /> Agents {formatMemBytes(agentBytes)}
                </span>
                <span>
                  <i className="hp-seg-projects" /> Projects {formatMemBytes(projectBytes)}
                </span>
                <span>
                  <i className="hp-seg-other" /> Other {formatMemBytes(data.otherBytes)}
                </span>
              </div>
            </>
          ) : error ? (
            // Only where nothing is standing in for it: a failed refresh OVER
            // figures already on screen changes their currency, not their truth,
            // and the footer is where that is said.
            <div className="hp-dim-line">Could not load the breakdown: {error}</div>
          ) : (
            <ColdComposition />
          )}
          {updateNote}
          {agentLine && <div className="hp-dim-line">{agentLine}</div>}
        </div>
        <div className="hp-section">
          {data == null ? (
            <ColdRows />
          ) : data.supported ? (
            <>
              <div className="hp-sect-label">Agents &amp; shells</div>
              {data.agents.length > 0 ? (
                data.agents.map((agent) => (
                  <ProcessRow
                    key={agent.sessionId}
                    name={sessionLabel(agent.sessionId)}
                    detail={`${agent.processCount} process${agent.processCount === 1 ? '' : 'es'}`}
                    bytes={agent.bytes}
                  />
                ))
              ) : (
                <div className="hp-dim-line">No sessions running.</div>
              )}
              <div className="hp-sect-label">Project processes</div>
              {data.projects.length > 0 ? (
                data.projects.map((project) => (
                  <ProcessRow
                    key={project.root}
                    name={project.root.split('/').pop() ?? project.root}
                    title={project.root}
                    detail={project.topProcesses.map((p) => p.name).join(', ')}
                    bytes={project.bytes}
                  />
                ))
              ) : (
                <div className="hp-dim-line">Nothing else running in your worktrees.</div>
              )}
              <ProcessRow name="Everything else on this machine" bytes={data.otherBytes} muted />
            </>
          ) : (
            <div className="hp-dim-line">
              This host can&apos;t attribute memory per process (no /proc) — totals only.
            </div>
          )}
        </div>
        <div className="hp-section">
          <div className="hp-sect-label">Reclaimable</div>
          <div className="hp-kv">
            <span className="hp-kv-key">Worktrees</span>
            <span className="hp-kv-value">
              {reclaimable
                ? `${reclaimCount} checkout${reclaimCount === 1 ? '' : 's'} · ${reclaimLabel}`
                : 'Counting checkouts…'}
              {orphanCount > 0 ? ` · ${orphanCount} unowned` : ''}
            </span>
            {onOpenReclaim && reclaimCount + orphanCount > 0 && (
              <button data-pressable type="button" className="hp-link" onClick={onOpenReclaim}>
                Review
              </button>
            )}
          </div>
          <div className="hp-kv">
            <span className="hp-kv-key">Idle sessions</span>
            <span className="hp-kv-value">
              {idleSplit.parkable} parkable · {idleSplit.protected} protected
              {metric?.idleCapUnmet != null && metric.idleCapUnmet > 0
                ? ` · ${metric.idleCapUnmet} cap unmet`
                : ''}
            </span>
          </div>
          {/* Not a readout — a standing caveat about what Review will and will
              not do. It reports no count, so it must not sit in the key column
              pretending to be one. */}
          <div className="hp-dim-line">
            Nothing is freed from here. Review proposes; you tick what goes.
          </div>
        </div>
        {(hibernation || worktreeGc) && (
          <div className="hp-hibernation">
            {hibernation && (
              <>
                {hibernation.enabled
                  ? hibActive
                    ? memActive
                      ? `Memory is past ${hibernation.memoryPct}%, so agents idle ${hibernation.idleMinutes} min are hibernating. One click resumes them. `
                      : `Load is past ${hibernation.loadPerCore}× per core, so agents idle ${hibernation.idleMinutes} min are hibernating. One click resumes them. `
                    : hibernation.loadPerCore != null
                      ? `Auto-hibernation on: agents idle ${hibernation.idleMinutes} min park past ${hibernation.loadPerCore}× load or ${hibernation.memoryPct}% memory. `
                      : `Auto-hibernation on: past ${hibernation.memoryPct}% memory, agents idle ${hibernation.idleMinutes} min park themselves. `
                  : 'Auto-hibernation is off — idle agents keep their memory until you hibernate them by hand. '}
                <button data-pressable type="button" className="hp-link" onClick={openHibernation}>
                  Hibernation settings
                </button>
              </>
            )}
            {worktreeGc && (
              <>
                {hibernation ? <br /> : null}
                {worktreeGc.mode === 'off'
                  ? 'Worktree GC is off. '
                  : worktreeGc.mode === 'auto'
                    ? `Worktree GC: auto-freeing after ${worktreeGc.afterDays} days. `
                    : `Worktree GC: proposing after ${worktreeGc.afterDays} days. `}
                <button data-pressable type="button" className="hp-link" onClick={openHibernation}>
                  GC settings
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <HealthPopoverFooter
        left={<SampleStamp at={fetchedAt} pending={pending} failed={failed} />}
        right={
          <button
            data-pressable
            type="button"
            className="hp-link hp-link-mono"
            onClick={onOpenConnection}
          >
            connection ▸
          </button>
        }
      />
    </>
  )
}

/**
 * When what you are reading was measured. A wall clock rather than a counted age
 * — the panel is open for seconds at a time, and a figure that ticks in the
 * corner is motion this shell does not spend on a footer. It answers the only
 * question a cache raises ("is this now, or a moment ago?") and stays still.
 *
 * A failed refresh is said HERE rather than over the numbers: what broke is the
 * currency of the figures, not the figures, and the stamp is where currency
 * lives. It keeps the time, so the operator can see exactly how old they are.
 */
function SampleStamp({
  at,
  pending,
  failed,
}: {
  at: number | null
  pending: boolean
  failed: boolean
}): JSX.Element {
  if (at == null) return <span>measuring…</span>
  const clock = new Date(at).toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  if (pending) return <span>re-measuring…</span>
  return <span>{failed ? `stale — sampled ${clock}` : `sampled ${clock}`}</span>
}

/**
 * The composition bar before the first walk answers: the bar's own track, empty,
 * and three runs at the legend's rhythm.
 *
 * Deliberately still — POD-394's rule, the same one the cold transcript and the
 * diff skeleton keep. Stillness is this shell's "needs you" signal and a pulsing
 * placeholder spends it on a local fetch. Held back 180ms in CSS so a warm cache
 * or a fast daemon never blinks it on screen.
 */
function ColdComposition(): JSX.Element {
  return (
    <div className="hp-cold">
      <div className="hp-seg" role="presentation" />
      <div className="hp-legend" aria-hidden="true">
        <span className="hp-cold-run" style={{ width: '74px' }} />
        <span className="hp-cold-run" style={{ width: '80px' }} />
        <span className="hp-cold-run" style={{ width: '62px' }} />
      </div>
      <div className="sr-only" role="status">
        Measuring memory per process…
      </div>
    </div>
  )
}

/** Both halves of the process list while it is unknown. The section labels are
 *  real, because the panel always has both; only the rows are slots, and their
 *  widths vary so the bytes column reads as separate figures rather than one
 *  block — the same thing the real column does with "4.2 GB" over "922 MB". */
const COLD_ROWS: ReadonlyArray<readonly [name: number, bytes: number]> = [
  [126, 38],
  [94, 32],
  [148, 40],
]

function ColdRows(): JSX.Element {
  return (
    <div className="hp-cold" aria-hidden="true">
      <div className="hp-sect-label">Agents &amp; shells</div>
      {COLD_ROWS.map(([name, bytes]) => (
        <div className="hp-prow" key={name}>
          <span className="hp-cold-run" style={{ width: `${name}px` }} />
          <span className="hp-cold-run hp-cold-run-bytes" style={{ width: `${bytes}px` }} />
        </div>
      ))}
      <div className="hp-sect-label">Project processes</div>
      {COLD_ROWS.slice(0, 2).map(([name, bytes]) => (
        <div className="hp-prow" key={name}>
          <span className="hp-cold-run" style={{ width: `${name - 30}px` }} />
          <span className="hp-cold-run hp-cold-run-bytes" style={{ width: `${bytes}px` }} />
        </div>
      ))}
    </div>
  )
}

function ProcessRow({
  name,
  detail,
  title,
  bytes,
  muted,
}: {
  name: string
  detail?: string
  title?: string
  bytes: number
  muted?: boolean
}): JSX.Element {
  return (
    <div className={cn('hp-prow', muted && 'hp-prow-muted')} title={title}>
      <span className="hp-prow-name">{name}</span>
      {detail && <span className="hp-prow-detail">{detail}</span>}
      <span className="hp-prow-bytes">{formatMemBytes(bytes)}</span>
    </div>
  )
}
