import { relativeTime } from '@podium/client-core'
import type { IssueWire } from '@podium/protocol'
import type { CSSProperties, JSX } from 'react'
import { effectiveIssueColorHex, FLOW_SLATE, issueSquareFg } from '@/lib/issueColors'
import { offerKey, type TrayItem } from './derive-tray'

export interface TrayActions {
  /** ✓ Done — merge: hand the merge instruction to the super agent. */
  onMerge: (item: TrayItem) => void
  /** Send back: compose feedback in the super agent chat. */
  onSendBack: (item: TrayItem) => void
  /** Discuss ↓ / Reply…: focus the chat composer with the item as context. */
  onDiscuss: (item: TrayItem) => void
  /** session →: open the issue's agent session in the native pane. */
  onOpenSession: (item: TrayItem) => void
  /** Quiet dismiss for a question (issues.clearNeedsHuman — answers ride the
   *  composer until #53 gives the web a real answer path). */
  onResolve: (item: TrayItem) => void
  /** An offer card's dynamic button [spec:SP-c7f1]: send the agent-authored
   *  prompt to ITS session as a normal user turn (the server then clears the
   *  offer, same as the chat/native offer bars). */
  onOfferAction: (item: Extract<TrayItem, { kind: 'offer' }>, prompt: string) => void
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
 * One human-actionable tray card (engraved-column.md §2.3): a review with its
 * action row, or a question with its answer chips. Each card is tinted by ITS
 * issue's colour (slate when uncoloured) — the colour bridges sidebar → tray.
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
  const flowHex = effectiveIssueColorHex(issue, (id) => issues.find((i) => i.id === id))
  const hex = flowHex ?? FLOW_SLATE
  const colored = flowHex !== undefined
  const review = item.kind === 'review'
  // An offer belongs to a SPECIFIC session; question/review cards fall back to
  // the issue's first live agent session for the name chip.
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
    border: `1px solid color-mix(in srgb, var(--issue) ${review ? (colored ? 60 : 55) : colored ? 40 : 40}%, transparent)`,
    background: `color-mix(in srgb, var(--issue) ${review ? (colored ? 20 : 14) : colored ? 10 : 8}%, #0e0e12)`,
  } as CSSProperties

  return (
    <div
      data-testid={`tray-card-${item.kind}`}
      data-issue-seq={issue.seq}
      data-issue-colored={colored ? 'true' : 'false'}
      className={`issue-scope flex flex-col gap-1.5 rounded-[10px] ${review ? 'px-[11px] py-[9px]' : 'px-[11px] py-2'} ${flash ? 'morph-row-flash' : ''}`}
      style={cardStyle}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="size-2 flex-none rounded-[3px]"
          style={{ background: 'var(--issue)' }}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate text-[11.5px] font-semibold text-(--issue-text)">
          #{issue.seq} {issue.title}
          {review && <span className="font-normal text-muted-foreground"> · ready for review</span>}
          {item.kind === 'offer' && (
            <span className="font-normal text-muted-foreground"> · suggests next steps</span>
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
      {review ? (
        <>
          <div className="text-[11px] leading-[1.5] text-(--issue-bright)">{item.body}</div>
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className="flex-none cursor-pointer rounded-[6px] border-0 px-2.5 py-[3px] text-[10.5px] font-semibold"
              style={{ background: 'var(--issue)', color: issueSquareFg(hex) }}
              onClick={() => actions.onMerge(item)}
            >
              ✓ Done — merge
            </button>
            <button
              type="button"
              className="flex-none cursor-pointer rounded-[6px] border border-[color-mix(in_srgb,var(--issue-text)_30%,transparent)] bg-transparent px-[9px] py-[3px] text-[10.5px] text-(--issue-text)"
              onClick={() => actions.onSendBack(item)}
            >
              Send back
            </button>
            <button
              type="button"
              className="flex-none cursor-pointer rounded-[6px] border border-border-strong bg-transparent px-[9px] py-[3px] text-[10.5px] text-[#9a9aa8]"
              onClick={() => actions.onDiscuss(item)}
            >
              Discuss ↓
            </button>
            <button
              type="button"
              className="ml-auto flex-none cursor-pointer border-0 bg-transparent p-0 text-[10px] text-muted-foreground hover:text-text-strong"
              onClick={() => actions.onOpenSession(item)}
            >
              session →
            </button>
          </div>
        </>
      ) : item.kind === 'offer' ? (
        <>
          {/* The same SessionOffer the chat/native offer bars render [spec:SP-c7f1]:
              freeform message, then the agent's own action buttons. */}
          <div className="whitespace-pre-wrap text-[11px] leading-[1.5] text-(--issue-bright)">
            {item.offer.message}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {item.offer.actions.map((action) => (
              <button
                key={`${action.label}:${action.prompt}`}
                type="button"
                title={action.prompt}
                className="flex-none cursor-pointer rounded-[6px] border border-[color-mix(in_srgb,var(--issue-text)_30%,transparent)] bg-[color-mix(in_srgb,var(--issue)_12%,transparent)] px-[9px] py-[3px] text-[10.5px] font-medium text-(--issue-text) transition-colors hover:bg-[color-mix(in_srgb,var(--issue)_24%,transparent)]"
                onClick={() => actions.onOfferAction(item, action.prompt)}
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              className="ml-auto flex-none cursor-pointer border-0 bg-transparent p-0 text-[10px] text-muted-foreground hover:text-text-strong"
              onClick={() => actions.onOpenSession(item)}
            >
              session →
            </button>
          </div>
        </>
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
              onClick={() => actions.onDiscuss(item)}
            >
              Reply…
            </button>
            <button
              type="button"
              className="ml-auto flex-none cursor-pointer border-0 bg-transparent p-0 text-[10px] text-muted-foreground hover:text-text-strong"
              title="Dismiss without answering"
              onClick={() => actions.onResolve(item)}
            >
              resolve ✓
            </button>
          </div>
        </>
      )}
    </div>
  )
}
