import { relativeTime } from '@podium/client-core'
import type { IssueWire } from '@podium/protocol'
import type { CSSProperties, JSX } from 'react'
import { effectiveIssueColorHex, FLOW_SLATE } from '@/lib/issueColors'
import { offerKey, type TrayItem } from './derive-tray'

export interface TrayActions {
  /** Reply…: focus the chat composer with the question as context. */
  onDiscuss: (item: TrayItem) => void
  /** session →: open the item's agent session in the native pane. */
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
 * One human-actionable tray card (engraved-column.md §2.3): an agent's action
 * offer with its dynamic buttons [spec:SP-c7f1], or a question with its answer
 * chips. Each card is tinted by ITS issue's colour (slate when uncoloured) —
 * the colour bridges sidebar → tray.
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users reach the same target via the session → button
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
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {item.offer.actions.map((action) => (
              <button
                key={`${action.label}:${action.prompt}`}
                type="button"
                title={action.prompt}
                className="flex-none cursor-pointer rounded-[6px] border border-[color-mix(in_srgb,var(--issue-text)_30%,transparent)] bg-[color-mix(in_srgb,var(--issue)_12%,transparent)] px-[9px] py-[3px] text-[10.5px] font-medium text-(--issue-text) transition-colors hover:bg-[color-mix(in_srgb,var(--issue)_24%,transparent)]"
                onClick={(e) => {
                  e.stopPropagation()
                  actions.onOfferAction(item, action.prompt)
                }}
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              className="ml-auto flex-none cursor-pointer border-0 bg-transparent p-0 text-[10px] text-muted-foreground hover:text-text-strong"
              onClick={(e) => {
                e.stopPropagation()
                actions.onOpenSession(item)
              }}
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
    </div>
  )
}
