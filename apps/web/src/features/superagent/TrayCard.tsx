import { relativeTime } from '@podium/client-core'
import { type IssueGitState, type IssueWire, issueDisplayRef } from '@podium/protocol'
import { type CSSProperties, type JSX, useState } from 'react'
import { OfferArtifactStrip } from '@/features/chat/OfferArtifactStrip'
import { composeOfferPrompt } from '@/features/chat/OfferBar'
import { effectiveIssueColorHex, FLOW_SLATE } from '@/lib/issueColors'
import { cn } from '@/lib/utils'
import { offerKey, type TrayItem } from './derive-tray'

export interface TrayActions {
  /** Reply…: focus the chat composer with the question as context. */
  onDiscuss: (item: TrayItem) => void
  /** Card click / session →: open the item's agent session in the native pane. */
  onOpenSession: (item: TrayItem) => void
  /** Quiet dismiss for a question (issues.clearNeedsHuman — answers ride the
   *  composer until #53 gives the web a real answer path). */
  onResolve: (item: TrayItem) => void
  /** An offer card's dynamic button [spec:SP-c7f1]: send the agent-authored
   *  prompt to ITS session as a normal user turn (the server then clears the
   *  offer, same as the chat/native offer bars). */
  onOfferAction: (item: Extract<TrayItem, { kind: 'offer' }>, prompt: string) => void
  /** Finished card's deterministic Archive: acknowledge a done task
   *  (issues.archive) — removes the card and the sidebar row together. */
  onArchive: (item: TrayItem) => void
}

export const itemKey = (item: TrayItem): string =>
  item.kind === 'offer'
    ? // A fresh offer on the same session is a new card — flash it again.
      `offer:${offerKey(item.session.sessionId, item.offer.createdAt)}`
    : `${item.kind}:${item.issue.id}`

/** The machine-set mono state line (§2.3-v3): stage · ⎇ branch · N ahead ·
 *  clean/N dirty — gitState fields only, no invented stats. Dirty count comes
 *  from the attributed set when the checkout is shared (same rule as GitStamp).
 *  Exported for tests. */
export function trayStateSegments(
  issue: Pick<IssueWire, 'stage' | 'gitState'>,
): { text: string; warn?: boolean }[] {
  // Lowercase mono stage label, e.g. `in_progress` → "in progress" (mock v3).
  const out: { text: string; warn?: boolean }[] = [{ text: issue.stage.replace(/_/g, ' ') }]
  const git: IssueGitState | undefined = issue.gitState
  if (!git || (git.computing && git.updatedAt === '')) return out
  if (git.branch) out.push({ text: `⎇ ${git.branch}` })
  if (!git.shared && git.ahead !== undefined && git.ahead > 0)
    out.push({ text: `${git.ahead} ahead` })
  const dirty = git.shared && git.dirtyOwn !== undefined ? git.dirtyOwn : git.dirtyFiles
  out.push(dirty > 0 ? { text: `${dirty} dirty`, warn: true } : { text: 'clean' })
  return out
}

function StateLine({ issue }: { issue: IssueWire }): JSX.Element {
  const segments = trayStateSegments(issue)
  return (
    <div
      data-testid="tray-state-line"
      className="truncate font-mono text-[9px] tracking-[.02em] tabular-nums text-muted-foreground"
    >
      {segments.map((s, i) => (
        <span key={s.text} className={s.warn ? 'text-destructive' : undefined}>
          {i > 0 && ' · '}
          {s.text}
        </span>
      ))}
    </div>
  )
}

/* 24px xs control scale (§2.3-v3): 11px label, 3px 12px padding, r6. */
const BTN =
  'inline-flex min-h-6 flex-none cursor-pointer items-center rounded-[6px] px-3 py-[3px] text-[11px] transition-colors'
const BTN_SEC = `${BTN} border border-[rgba(243,243,248,.28)] bg-transparent text-foreground hover:border-[rgba(243,243,248,.5)]`
const BTN_TER = `${BTN} border border-border-strong bg-transparent text-muted-foreground hover:border-text-dim hover:text-foreground`

function PrimaryButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string
  title?: string
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      className={`${BTN} border-0 font-semibold hover:opacity-85 disabled:cursor-default disabled:opacity-50`}
      style={{ background: 'var(--issue)', color: 'color-mix(in srgb, var(--issue) 25%, #000)' }}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {label}
    </button>
  )
}

function SessionLink({ item, actions }: { item: TrayItem; actions: TrayActions }): JSX.Element {
  return (
    <button
      type="button"
      data-testid="tray-session-link"
      className="ml-auto flex-none cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 text-[10px] text-text-dim hover:text-muted-foreground"
      onClick={(e) => {
        e.stopPropagation()
        actions.onOpenSession(item)
      }}
    >
      session →
    </button>
  )
}

/**
 * One human-actionable tray card (engraved-column.md §2.3-v3): an agent's
 * action offer with its dynamic buttons [spec:SP-c7f1], a question with
 * Reply…/resolve, or a deterministic finished card with its Archive
 * acknowledgment. Colour is issue IDENTITY, never state: each card tints with
 * ITS issue's user-assigned colour (slate when uncoloured); the selected issue
 * adds only a ring, never a re-sort.
 */
export function TrayCard({
  item,
  issues,
  actions,
  now,
  selected = false,
  arrived = false,
}: {
  item: TrayItem
  /** Full issue list — colour inheritance walks ancestors (§2.5: sub-issues
   *  of a coloured issue flow ITS colour). */
  issues: IssueWire[]
  actions: TrayActions
  now: number
  /** The selected issue's cards get the colour ring — nothing else changes. */
  selected?: boolean
  /** One-shot arrival choreography (motion.md §2.1): surface flash, ago flip,
   *  actions tick in. The Tray sets this exactly once per new card key. */
  arrived?: boolean
}): JSX.Element {
  const issue = item.issue
  // An offer's `input` action awaiting feedback (index into offer.actions).
  const [pending, setPending] = useState<number | null>(null)
  const [feedback, setFeedback] = useState('')
  const flowHex = effectiveIssueColorHex(issue, (id) => issues.find((i) => i.id === id))
  const hex = flowHex ?? FLOW_SLATE
  const colored = flowHex !== undefined
  // An offer belongs to a SPECIFIC session; question cards fall back to the
  // issue's first live agent session for the name chip.
  const agentSession =
    item.kind === 'offer'
      ? item.session
      : (issue.sessions ?? []).find(
          (s) => !s.archived && s.agentKind !== 'shell' && s.headless !== true,
        )
  const ago = relativeTime(item.since, now)
  // §2.3-v3 tint tiers: offer/review 16%/.55, question 9%/.38, finished 7%/.30.
  const tier =
    item.kind === 'question'
      ? { mix: 'issue-mix-9 issue-hairline-38', hover: 'hover:issue-hairline-60' }
      : item.kind === 'finished'
        ? { mix: 'issue-mix-7 issue-hairline-30', hover: 'hover:issue-hairline-50' }
        : { mix: 'issue-mix-16 issue-hairline-55', hover: 'hover:issue-hairline-80' }
  const cardStyle = {
    '--issue': hex,
    ...(selected
      ? {
          boxShadow:
            '0 0 0 1px color-mix(in srgb, var(--issue) 35%, transparent), 0 0 14px -4px color-mix(in srgb, var(--issue) 45%, transparent)',
        }
      : {}),
  } as CSSProperties
  const offerLines = item.kind === 'offer' ? item.offer.message.trim().split('\n') : []
  const headline = offerLines[0]?.trim() ?? ''
  const body = offerLines.slice(1).join('\n').trim()

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the whole card is a shortcut to its session; the inner buttons stay the accessible path
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users reach the same session via its sidebar row or the session → button
    <div
      data-testid={`tray-card-${item.kind}`}
      data-issue-seq={issue.seq}
      data-issue-colored={colored ? 'true' : 'false'}
      data-selected={selected || undefined}
      className={cn(
        'issue-scope flex cursor-pointer flex-col gap-1.5 rounded-[10px] border px-[11px] transition-[border-color]',
        item.kind === 'finished' ? 'py-[7px] opacity-[.88]' : 'py-[9px]',
        tier.mix,
        tier.hover,
        arrived && 'morph-card-flash',
      )}
      style={cardStyle}
      // Anywhere on the card focuses the related native agent tab; the action
      // buttons stop propagation so acting never also navigates.
      onClick={() => actions.onOpenSession(item)}
    >
      {/* Header row (§2.3-v3): square · mono ref · title · ◆ agent · frozen ago */}
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="size-2 flex-none rounded-[3px]"
          style={{ background: 'var(--issue)' }}
          aria-hidden="true"
        />
        <span
          className="flex-none font-mono text-[9.5px]"
          style={{ color: 'color-mix(in srgb, var(--issue) 65%, #f3f3f8)' }}
        >
          {issueDisplayRef(issue)}
        </span>
        <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">{issue.title}</span>
        {item.kind !== 'finished' && agentSession?.name && (
          <span className="flex-none truncate whitespace-nowrap text-[9.5px] text-text-dim">
            · <span className="text-claude">◆</span> {agentSession.name}
          </span>
        )}
        <span
          className={cn(
            'ml-auto flex-none font-mono text-[9px] tabular-nums text-attention',
            arrived && 'morph-flip-ago',
          )}
        >
          {ago}
        </span>
      </div>
      {item.kind === 'offer' ? (
        pending !== null && item.offer.actions[pending] ? (
          // --action-input feedback state (§2.3-v3): the card body swaps for a
          // 2-row field; send composes prompt + feedback as one user turn.
          // biome-ignore lint/a11y/noStaticElementInteractions: only swallows card-click navigation around the field
          // biome-ignore lint/a11y/useKeyWithClickEvents: not an interactive target, just a propagation fence
          <div
            data-testid="tray-offer-feedback"
            className="flex flex-col gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[12px] font-semibold leading-[1.35] text-(--issue-text)">
              {item.offer.actions[pending].label} — add your feedback
            </div>
            <textarea
              // biome-ignore lint/a11y/noAutofocus: the field appears on the user's own click; focus is the expected next step
              autoFocus
              rows={2}
              value={feedback}
              placeholder="What should change?"
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                const action = item.offer.actions[pending]
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && action && feedback.trim()) {
                  actions.onOfferAction(item, composeOfferPrompt(action.prompt, feedback))
                }
                if (e.key === 'Escape') setPending(null)
              }}
              className="w-full resize-none rounded-[6px] border bg-[rgba(8,8,12,.7)] px-[9px] py-1.5 text-[11px] leading-[1.45] text-foreground outline-none issue-hairline-40 placeholder:text-text-dim focus:issue-hairline-70"
            />
            <div className="flex min-w-0 items-center gap-1.5">
              <PrimaryButton
                label="Send"
                disabled={!feedback.trim()}
                onClick={() => {
                  const action = item.offer.actions[pending]
                  if (action && feedback.trim()) {
                    actions.onOfferAction(item, composeOfferPrompt(action.prompt, feedback))
                  }
                }}
              />
              <button
                type="button"
                className={BTN_TER}
                onClick={(e) => {
                  e.stopPropagation()
                  setPending(null)
                  setFeedback('')
                }}
              >
                Cancel
              </button>
              <span className="ml-auto min-w-0 truncate font-mono text-[8px] tracking-[.04em] text-text-faint">
                appended to “{item.offer.actions[pending].prompt.slice(0, 32)}…”
              </span>
            </div>
          </div>
        ) : (
          <>
            {/* Headline = first message line; state line = machine-set git facts;
                body = the rest, clamped — overflow reads in the session. */}
            {headline && (
              <div className="text-[12px] font-semibold leading-[1.35] text-(--issue-text) [text-wrap:balance]">
                {headline}
              </div>
            )}
            <StateLine issue={issue} />
            {body && (
              <div className="line-clamp-2 whitespace-pre-wrap text-[11px] leading-[1.5] text-(--issue-bright)">
                {body}
              </div>
            )}
            {/* Evidence thumbnails [POD-120]: agent-curated --artifact paths
                first, freshness fallback; clicks preview without entering the
                session — the strip stops its own propagation. */}
            <OfferArtifactStrip offer={item.offer} session={item.session} />
            <div
              className={cn(
                'flex min-w-0 flex-wrap items-center gap-1.5',
                arrived && 'morph-tick-in',
              )}
            >
              {item.offer.actions.map((action, ai) =>
                ai === 0 && action.input !== true ? (
                  <PrimaryButton
                    key={`${action.label}:${action.prompt}`}
                    label={action.label}
                    title={action.prompt}
                    onClick={() => actions.onOfferAction(item, action.prompt)}
                  />
                ) : (
                  <button
                    key={`${action.label}:${action.prompt}`}
                    type="button"
                    title={action.prompt}
                    className={BTN_SEC}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (action.input === true) setPending(ai)
                      else actions.onOfferAction(item, action.prompt)
                    }}
                  >
                    {action.label}
                    {action.input === true && '…'}
                  </button>
                ),
              )}
              <SessionLink item={item} actions={actions} />
            </div>
          </>
        )
      ) : item.kind === 'finished' ? (
        <div className="flex min-w-0 items-center gap-2 text-[10.5px] text-muted-foreground">
          <span className="min-w-0 truncate">
            {issue.closedReason?.trim() || 'Done.'}
            {issue.gitState?.commits?.length
              ? ` · ${issue.gitState.commits[issue.gitState.commits.length - 1]?.slice(0, 7)}`
              : ''}
          </span>
          <button
            type="button"
            title="Acknowledge and archive this task"
            className={`${BTN_TER} ml-auto`}
            onClick={(e) => {
              e.stopPropagation()
              actions.onArchive(item)
            }}
          >
            Archive ✓
          </button>
        </div>
      ) : item.kind === 'review' ? (
        // Backstop review card [POD-118]: minimal by design — the agent's own
        // offer (with its buttons) is the richer form; this only guarantees a
        // review-stage issue is never invisible. Card click opens the session.
        <>
          <div className="text-[12px] font-semibold leading-[1.35] text-(--issue-text) [text-wrap:balance]">
            Ready for review
          </div>
          <StateLine issue={issue} />
          <div className={cn('flex min-w-0 items-center', arrived && 'morph-tick-in')}>
            <SessionLink item={item} actions={actions} />
          </div>
        </>
      ) : (
        <>
          <div className="text-[11px] leading-[1.5] text-(--issue-bright)">
            asks: <span className="text-text-strong">“{item.text}”</span>
          </div>
          <div
            className={cn(
              'flex min-w-0 flex-wrap items-center gap-1.5',
              arrived && 'morph-tick-in',
            )}
          >
            {/* Answer chips render here once the backend carries options (#53);
                until then Reply… routes the answer through the composer. */}
            <button
              type="button"
              className={BTN_TER}
              onClick={(e) => {
                e.stopPropagation()
                actions.onDiscuss(item)
              }}
            >
              Reply…
            </button>
            <button
              type="button"
              className={BTN_TER}
              title="Dismiss without answering"
              onClick={(e) => {
                e.stopPropagation()
                actions.onResolve(item)
              }}
            >
              resolve ✓
            </button>
            <SessionLink item={item} actions={actions} />
          </div>
        </>
      )}
    </div>
  )
}
