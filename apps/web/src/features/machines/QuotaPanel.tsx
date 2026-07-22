import type { QuotaWindowWire } from '@podium/protocol'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { HealthPopoverFooter } from './HealthPopover'
import {
  type AccountQuotaGroup,
  agentLabel,
  formatReset,
  paceHint,
  paceLabel,
  percentTone,
  quotaPoolVerdict,
  statusNote,
  windowElapsedPercent,
  windowPace,
  windowShortLabel,
} from './quota'

/**
 * The agent-quota popover body. Hover tier: verdict header + one aligned
 * instrument row per plan window (bar with the elapsed-time tick). Pinned
 * tier: adds the pace verdict lines ("won't last" / "headroom"; "on pace" is
 * silent) and the degraded accounts.
 */
export function QuotaPanel({
  groups,
  pinned,
  now,
}: {
  groups: AccountQuotaGroup[]
  pinned: boolean
  now: number
}): JSX.Element {
  const ok = groups.filter((g) => g.status === 'ok')
  const degraded = groups.filter((g) => g.status !== 'ok')
  const verdict = quotaPoolVerdict(groups, now)
  return (
    <>
      <div className="hp-header">
        <span className="hp-title">Agent quota</span>
        <span
          className={cn(
            'hp-verdict',
            verdict.mixed ? 'hp-verdict-mixed' : `hp-verdict-${verdict.tone}`,
          )}
        >
          <span className="hp-verdict-dots" aria-hidden="true">
            {verdict.tones.map((tone) => (
              <i key={tone} className={`hp-verdict-dot-${tone}`} />
            ))}
          </span>
          {verdict.label}
        </span>
      </div>
      {ok.length === 0 && <div className="hp-section hp-dim-line">No quota reported</div>}
      {ok.map((g) => (
        <div key={g.key} className="hp-section">
          <div className="hp-acct">
            <span className="hp-acct-agent">{agentLabel(g.agent)}</span>
            {g.account?.plan && <span className="hp-acct-plan">{g.account.plan}</span>}
            {g.account?.email && <span className="hp-acct-sub">{g.account.email}</span>}
          </div>
          {g.windows.map((w) => (
            <WindowRow key={w.key} w={w} now={now} pinned={pinned} />
          ))}
        </div>
      ))}
      {pinned &&
        degraded.map((g) => (
          <div key={g.key} className="hp-section hp-acct">
            <span className="hp-acct-agent">{agentLabel(g.agent)}</span>
            <span className="hp-acct-sub">{statusNote(g)}</span>
          </div>
        ))}
      {!pinned && <HealthPopoverFooter left="click to pin breakdown" right="esc closes" />}
    </>
  )
}

function WindowRow({
  w,
  now,
  pinned,
}: {
  w: QuotaWindowWire
  now: number
  pinned: boolean
}): JSX.Element {
  const elapsed = windowElapsedPercent(w.resetsAt, w.windowMinutes, now)
  const pace = windowPace(w, now)
  const tone = percentTone(w.usedPercent)
  const used = Math.min(100, Math.max(0, w.usedPercent))
  return (
    <>
      <div className="hp-winrow">
        <span className="hp-winlabel">{windowShortLabel(w.label)}</span>
        <span
          className="hp-bar"
          role="presentation"
          title={elapsed !== null ? `${Math.round(elapsed)}% of window elapsed` : undefined}
        >
          <span className={cn('hp-fill', `hp-fill-${tone}`)} style={{ width: `${used}%` }} />
          {elapsed !== null && (
            <span
              className="hp-tick"
              style={{ left: `${Math.min(99, Math.max(1, elapsed))}%` }}
              aria-hidden="true"
            />
          )}
        </span>
        <span className="hp-num">
          {Math.round(w.usedPercent)}%{' '}
          <small>· {formatReset(w.resetsAt, now).replace('resets in ', '')}</small>
        </span>
      </div>
      {/* Pace verdicts only once pinned, and only when they change a decision —
          "on pace" stays silent. */}
      {pinned && pace && pace !== 'on-pace' && elapsed !== null && (
        <div className="hp-pace">
          <span className={cn('hp-pace-chip', pace === 'hot' ? 'hp-pace-hot' : 'hp-pace-ok')}>
            {paceLabel(pace)}
          </span>
          <span>{paceHint(pace, w.usedPercent, elapsed)}</span>
        </div>
      )}
    </>
  )
}
