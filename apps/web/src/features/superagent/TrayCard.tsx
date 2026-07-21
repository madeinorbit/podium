import { relativeTime } from '@podium/client-core'
import type { IssueWire } from '@podium/protocol'
import { type CSSProperties, type JSX, useState } from 'react'
import { GitStamp } from '@/components/GitStamp'
import { composeOfferPrompt } from '@/features/chat/OfferBar'
import { effectiveIssueColorHex, FLOW_SLATE } from '@/lib/issueColors'
import { offerKey, type TrayItem } from './derive-tray'

export interface TrayActions {
  /** Reply…: focus the chat composer with the question as context. */
  onDiscuss: (item: TrayItem) => void
  /** Card click: open the item's agent session in the native pane. */
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

/** Cards that already row-flashed this app session — a card flashes amber once
 *  when it ARRIVES, not every time a collapse/expand remounts the tray. */
const flashed = new Set<string>()

export const itemKey = (item: TrayItem): string =>
  item.kind === 'offer'
    ? // A fresh offer on the same session is a new card — flash it again.
      `offer:${offerKey(item.session.sessionId, item.offer.createdAt)}`
    : `${item.kind}:${item.issue.id}`

/**
 * One human-actionable tray card (engraved-column.md §2.3): an agent's action
 * offer with its dynamic buttons [spec:SP-c7f1], a question with its answer
 * chips, or a deterministic finished card with its Archive acknowledgment.
 * Each card is tinted by ITS issue's colour (slate when uncoloured) — the
 * colour bridges sidebar → tray.
 */
export function TrayCard({
  item,
  issues,
  actions,
  now,
}: {
  item: TrayItem
  /** Full issue list — colour inheritance walks ancestors (§2.5: sub-issues
   *  of a coloured issue flow ITS colour). */
  issues: IssueWire[]
  actions: TrayActions
  now: number
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
  const flash = !flashed.has(itemKey(item))
  if (flash) flashed.add(itemKey(item))
  const ago = relativeTime(item.since, now)
  const cardStyle = {
    '--issue': hex,
    border: `1px solid color-mix(in srgb, var(--issue) 40%, transparent)`,
    background: `color-mix(in srgb, var(--issue) ${colored ? 10 : 8}%, #0e0e12)`,
  } as CSSProperties

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the whole card is a shortcut to its session; the inner buttons stay the accessible path
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users reach the same session via its sidebar row
    <div
      data-testid={`tray-card-${item.kind}`}
      data-issue-seq={issue.seq}
      data-issue-colored={colored ? 'true' : 'false'}
      className={`issue-scope flex cursor-pointer flex-col gap-1.5 rounded-[10px] px-[11px] py-2 ${flash ? 'morph-row-flash' : ''}`}
      style={cardStyle}
      // Anywhere on the card focuses the related native agent tab; the action
      // buttons stop propagation so acting never also navigates.
      onClick={() => actions.onOpenSession(item)}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="size-2 flex-none rounded-[3px]"
          style={{ background: 'var(--issue)' }}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate text-[11.5px] font-semibold text-(--issue-text)">
          #{issue.seq} {issue.title}
          {item.kind === 'offer' && (
            <span className="font-normal text-muted-foreground"> · suggests next steps</span>
          )}
          {item.kind === 'finished' && (
            <span className="font-normal text-muted-foreground"> · finished</span>
          )}
          {item.kind === 'review' && (
            <span className="font-normal text-muted-foreground"> · in review</span>
          )}
        </span>
        {agentSession?.name && (
          <span className="flex-none truncate text-[9.5px] text-muted-foreground">
            · <span className="text-claude">◆</span> {agentSession.name}
          </span>
        )}
        <span
          key={ago}
          className="morph-flip-ago ml-auto flex-none font-mono text-[9px] text-attention"
        >
          {ago}
        </span>
      </div>
      {item.kind === 'offer' ? (
        <>
          {/* The same SessionOffer the chat/native offer bars render [spec:SP-c7f1]:
              freeform message, then the agent's own action buttons. */}
          <div className="whitespace-pre-wrap text-[11px] leading-[1.5] text-(--issue-bright)">
            {item.offer.message}
          </div>
          {pending !== null && item.offer.actions[pending] ? (
            // Feedback overlay for an `input` action (e.g. "Send back"): the
            // agent declared this button only makes sense with an explanation,
            // so collect it here and send prompt + feedback as one turn.
            // biome-ignore lint/a11y/noStaticElementInteractions: only swallows card-click navigation around the field
            // biome-ignore lint/a11y/useKeyWithClickEvents: not an interactive target, just a propagation fence
            <div
              data-testid="tray-offer-feedback"
              className="flex flex-col gap-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              <textarea
                // biome-ignore lint/a11y/noAutofocus: the field appears on the user's own click; focus is the expected next step
                autoFocus
                rows={2}
                value={feedback}
                placeholder={`${item.offer.actions[pending].label} — add your feedback…`}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  const action = item.offer.actions[pending]
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && action && feedback.trim()) {
                    actions.onOfferAction(item, composeOfferPrompt(action.prompt, feedback))
                  }
                  if (e.key === 'Escape') setPending(null)
                }}
                className="w-full resize-none rounded-[6px] border border-[color-mix(in_srgb,var(--issue-text)_30%,transparent)] bg-transparent px-2 py-1.5 text-[11px] text-(--issue-bright) outline-none placeholder:text-muted-foreground"
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={!feedback.trim()}
                  className="flex-none cursor-pointer rounded-[6px] border border-[color-mix(in_srgb,var(--issue-text)_30%,transparent)] bg-[color-mix(in_srgb,var(--issue)_12%,transparent)] px-[9px] py-[3px] text-[10.5px] font-medium text-(--issue-text) transition-colors hover:bg-[color-mix(in_srgb,var(--issue)_24%,transparent)] disabled:cursor-default disabled:opacity-50"
                  onClick={(e) => {
                    e.stopPropagation()
                    const action = item.offer.actions[pending]
                    if (action && feedback.trim()) {
                      actions.onOfferAction(item, composeOfferPrompt(action.prompt, feedback))
                    }
                  }}
                >
                  {item.offer.actions[pending].label}
                </button>
                <button
                  type="button"
                  className="flex-none cursor-pointer border-0 bg-transparent p-0 text-[10px] text-muted-foreground hover:text-text-strong"
                  onClick={(e) => {
                    e.stopPropagation()
                    setPending(null)
                    setFeedback('')
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {item.offer.actions.map((action, ai) => (
                <button
                  key={`${action.label}:${action.prompt}`}
                  type="button"
                  title={action.prompt}
                  className="flex-none cursor-pointer rounded-[6px] border border-[color-mix(in_srgb,var(--issue-text)_30%,transparent)] bg-[color-mix(in_srgb,var(--issue)_12%,transparent)] px-[9px] py-[3px] text-[10.5px] font-medium text-(--issue-text) transition-colors hover:bg-[color-mix(in_srgb,var(--issue)_24%,transparent)]"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (action.input === true) setPending(ai)
                    else actions.onOfferAction(item, action.prompt)
                  }}
                >
                  {action.label}
                  {action.input === true && '…'}
                </button>
              ))}
            </div>
          )}
        </>
      ) : item.kind === 'finished' ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[11px] leading-[1.5] text-(--issue-bright)">
            {issue.closedReason?.trim() || 'Done.'}
          </span>
          <button
            type="button"
            title="Acknowledge and archive this task"
            className="ml-auto flex-none cursor-pointer rounded-[6px] border border-[color-mix(in_srgb,var(--issue-text)_30%,transparent)] bg-transparent px-[9px] py-[3px] text-[10.5px] text-(--issue-text)"
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
        <div className="min-w-0 truncate text-[11px] leading-[1.5] text-(--issue-bright)">
          Ready for review.
        </div>
      ) : (
        <>
          <div className="pl-[14px] text-[11px] leading-[1.5] text-(--issue-bright)">
            asks: “{item.text}”
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-[5px] pl-[15px]">
            {/* Answer chips render here once the backend carries options (#53);
                until then Reply… routes the answer through the composer. */}
            <button
              type="button"
              className="flex-none cursor-pointer whitespace-nowrap rounded-[5px] border border-border-strong bg-transparent px-2 py-[2px] text-[10px] text-[#9a9aa8]"
              onClick={(e) => {
                e.stopPropagation()
                actions.onDiscuss(item)
              }}
            >
              Reply…
            </button>
            <button
              type="button"
              className="ml-auto flex-none cursor-pointer border-0 bg-transparent p-0 text-[10px] text-muted-foreground hover:text-text-strong"
              title="Dismiss without answering"
              onClick={(e) => {
                e.stopPropagation()
                actions.onResolve(item)
              }}
            >
              resolve ✓
            </button>
          </div>
        </>
      )}
      {/* Git footer [POD-98]: the merge/send-back decision needs the git facts
          ON the card — a dirty tree here visibly contradicts "ready to merge". */}
      {issue.gitState && (
        <div
          data-testid="tray-card-git"
          className="flex min-w-0 items-center border-t pt-1.5"
          style={{ borderColor: 'color-mix(in srgb, var(--issue) 25%, transparent)' }}
        >
          <GitStamp
            issueBranch={issue.branch}
            git={issue.gitState}
            density="footer"
            className="min-w-0 text-muted-foreground"
          />
        </div>
      )}
    </div>
  )
}
