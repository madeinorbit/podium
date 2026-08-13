import {
  type AccountQuotaGroup,
  agentLabel,
  formatReset,
  groupGatingPace,
  modelLimitNote,
  paceLabel,
  percentTone,
  type QuotaPace,
  quotaPoolVerdict,
  splitQuotaWindows,
  windowElapsedPercent,
  windowScopeModel,
  windowShortLabel,
} from '@podium/client-core/viewmodels'
import type { QuotaWindowWire } from '@podium/model'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

const PACE_CHIP: Record<QuotaPace, string> = {
  comfortable: 'hp-pace-ok',
  'on-pace': 'hp-pace-even',
  hot: 'hp-pace-hot',
}

/**
 * The agent-quota hover panel: verdict header, one instrument row per plan
 * window, and a pace chip on each harness. There is no pinned / detailed tier —
 * click does not grow this panel.
 */
export function QuotaPanel({
  groups,
  now,
}: {
  groups: AccountQuotaGroup[]
  now: number
}): JSX.Element {
  const ok = groups.filter((g) => g.status === 'ok')
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
      {/* Scrolls once the accounts outgrow the popover's cap — see `.hp-scroll`. */}
      <div className="hp-scroll">
        {ok.length === 0 && <div className="hp-section hp-dim-line">No quota reported</div>}
        {ok.map((g) => {
          const { gating, models } = splitQuotaWindows(g.windows)
          const pace = groupGatingPace(g, now)
          return (
            <div key={g.key} className="hp-section">
              <div className="hp-acct">
                <span className="hp-acct-agent">{agentLabel(g.agent)}</span>
                {g.account?.plan && <span className="hp-acct-plan">{g.account.plan}</span>}
                {pace && (
                  <span className={cn('hp-pace-chip', PACE_CHIP[pace])}>{paceLabel(pace)}</span>
                )}
                {g.account?.email && <span className="hp-acct-sub">{g.account.email}</span>}
              </div>
              {gating.map((w) => (
                <WindowRow key={w.key} w={w} now={now} />
              ))}
              {/* Model-scoped buckets read as a separate tier — they are extra
                capacity for one model, not a limit on the harness (POD-271). */}
              {models.length > 0 && (
                <>
                  <div className="hp-sect-label hp-model-label">Model limits</div>
                  {models.map((w) => (
                    <WindowRow key={w.key} w={w} now={now} />
                  ))}
                  <div className="hp-model-note">{modelLimitNote(g.agent, g.windows)}</div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

function WindowRow({ w, now }: { w: QuotaWindowWire; now: number }): JSX.Element {
  const elapsed = windowElapsedPercent(w.resetsAt, w.windowMinutes, now)
  const tone = percentTone(w.usedPercent)
  const used = Math.min(100, Math.max(0, w.usedPercent))
  return (
    <div className="hp-winrow">
      {/* A scoped window is titled by its model, not by its window kind — the
          model is what the operator loses when it runs out. */}
      <span className="hp-winlabel">{windowScopeModel(w) ?? windowShortLabel(w.label)}</span>
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
  )
}
