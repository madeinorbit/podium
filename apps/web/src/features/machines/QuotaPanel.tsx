import {
  type AccountQuotaGroup,
  agentLabel,
  formatReset,
  groupGatingPace,
  paceLabel,
  percentTone,
  type QuotaPace,
  quotaPoolVerdict,
  splitQuotaWindows,
  windowElapsedPercent,
  windowScopeModel,
  windowShortLabel,
} from '@podium/client-core/viewmodels'
import type { QuotaWindowWire } from '@podium/model/browser'
import type { JSX } from 'react'
import {
  ClaudeCodeIcon,
  CursorIcon,
  GrokIcon,
  OpenAIcon,
  OpenCodeIcon,
} from '@/lib/icons/AgentIcons'
import { cn } from '@/lib/utils'

const PACE_CHIP: Record<QuotaPace, string> = {
  comfortable: 'hp-pace-ok',
  'on-pace': 'hp-pace-even',
  hot: 'hp-pace-hot',
}

const QUOTA_PANEL_ICONS: Record<AccountQuotaGroup['agent'], typeof ClaudeCodeIcon | null> = {
  'claude-code': ClaudeCodeIcon,
  codex: OpenAIcon,
  grok: GrokIcon,
  opencode: OpenCodeIcon,
  cursor: CursorIcon,
  shell: null,
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
        <span className="hp-verdict">
          {verdict.label.split(' · ').map((label, index) => {
            const tone = verdict.tones[index] ?? verdict.tone
            return (
              <span key={`${tone}-${label}`} className={`hp-verdict-item hp-verdict-${tone}`}>
                <i aria-hidden="true" />
                {label}
              </span>
            )
          })}
        </span>
      </div>
      {/* Scrolls once the accounts outgrow the popover's cap — see `.hp-scroll`. */}
      <div className="hp-scroll">
        {ok.length === 0 && <div className="hp-section hp-dim-line">No quota reported</div>}
        {ok.map((g) => {
          const { gating, models } = splitQuotaWindows(g.windows)
          const pace = groupGatingPace(g, now)
          const Icon = QUOTA_PANEL_ICONS[g.agent]
          return (
            <div key={g.key} className="hp-section">
              <div className="hp-acct">
                {Icon && (
                  <Icon size={13} variant="mono" className="hp-acct-icon" aria-hidden={true} />
                )}
                <span className="hp-acct-agent">{agentLabel(g.agent)}</span>
                {g.account?.plan && <span className="hp-acct-plan">{g.account.plan}</span>}
                {pace && (
                  <span className={cn('hp-pace-chip', PACE_CHIP[pace])}>{paceLabel(pace)}</span>
                )}
                {g.account?.email && <span className="hp-acct-sub">{g.account.email}</span>}
              </div>
              {gating.map((w) => (
                <WindowRow key={w.key} w={w} now={now} pace={pace} />
              ))}
              {/* A model-scoped bucket is extra capacity for one model, not a
                  limit on the harness (POD-271) — so it hangs off the window
                  rows as a sub-row of the week meter it lives inside, on the
                  same grid. No section label, no repeated reset time, no prose:
                  the ↳ and the thinner track say "subordinate" on their own. */}
              {models.map((w) => (
                <ModelWindowRow key={w.key} w={w} />
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}

function WindowRow({
  w,
  now,
  pace,
}: {
  w: QuotaWindowWire
  now: number
  pace: QuotaPace | null
}): JSX.Element {
  const elapsed = windowElapsedPercent(w.resetsAt, w.windowMinutes, now)
  const percent = percentTone(w.usedPercent)
  const tone = percent === 'crit' ? percent : pace === 'hot' ? 'warn' : percent
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
      <span className="hp-num">{Math.round(w.usedPercent)}%</span>
      <span className="hp-reset">{formatReset(w.resetsAt, now).replace('resets in ', '')}</span>
    </div>
  )
}

/**
 * A model-scoped window, rendered as a sub-row of the harness meters above it.
 * It carries no elapsed tick and no reset time: it resets with the window it
 * hangs under, and printing that again in the fourth column only made the
 * operator read the same figure twice.
 */
function ModelWindowRow({ w }: { w: QuotaWindowWire }): JSX.Element {
  const tone = percentTone(w.usedPercent)
  const used = Math.min(100, Math.max(0, w.usedPercent))
  return (
    <div className="hp-model-row">
      <span className="hp-model-branch" aria-hidden="true">
        ↳
      </span>
      <span className="hp-model-meter">
        <span className="hp-model-name">{windowScopeModel(w) ?? w.label}</span>
        <span className="hp-bar" role="presentation">
          <span className={cn('hp-fill', `hp-fill-${tone}`)} style={{ width: `${used}%` }} />
        </span>
      </span>
      <span className="hp-num">{Math.round(w.usedPercent)}%</span>
      <span />
    </div>
  )
}
