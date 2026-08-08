import type { SessionMeta } from '@podium/model'
import type { useVoiceInput } from '@podium/terminal-client-react'
import { ArrowUp, Clock, CloudOff, Paperclip, Square } from 'lucide-react'
import type { JSX, RefObject } from 'react'
import { useEffect, useMemo } from 'react'
import { useReplicaIssues } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { usePromptAutoGrow } from '@/lib/use-prompt-auto-grow'
import { AtMentionMenu } from '@/lib/at-mention/AtMentionMenu'
import { issueMentions } from '@/lib/at-mention/mention-sources'
import { useAtMenu, useAtTrigger } from '@/lib/at-mention/useAtMention'
import { useFileMentions } from '@/lib/at-mention/useFileMentions'
import { BlockCaret } from '@/lib/BlockCaret'
import { cn } from '@/lib/utils'
import { AttachmentStrip } from './AttachmentStrip'
import { OfferBar } from './OfferBar'
import type { UseAttachmentsResult } from './use-attachments'
import { VoiceButton } from './VoiceButton'

/**
 * The shared auto-grow, as a renderless child instead of a call in the body.
 *
 * `compact` is fixed for the lifetime of a mounted composer, so rendering the
 * hook conditionally is stable — and it is what keeps the two height
 * implementations from ever both running. The alternative (one hook taking an
 * `enabled` flag) would put the main chat's height back on the Superagent's
 * code path, which is the one thing this split exists to prevent.
 */
function PromptAutoGrow({
  taRef,
  value,
}: {
  taRef: RefObject<HTMLTextAreaElement | null>
  value: string
}): null {
  usePromptAutoGrow({ taRef, value })
  return null
}

/**
 * THE COMPOSER (POD-405) — one auto-growing box with the attach / voice / send
 * actions inside it, Claude-iOS style, plus the four notice lines that belong to
 * the act of sending (offer bar, queue depth, turn error, offline copy).
 *
 * ---------------------------------------------------------------------------
 * THE DRAFT GOES THROUGH THE ACTIONS SEAM, AND THIS COMPONENT HOLDS NO MERGE
 * ---------------------------------------------------------------------------
 *
 * `value` in, `onChange` out — one action call (`setSessionDraft`, POD-402) per
 * keystroke, and no reconciliation of any kind in here. That is deliberate and
 * it is the one thing in this refactor that a future phase depends on:
 *
 *   The composer draft is PERSONAL-class shared-surface state (doc §3.1.1). It
 *   is NOT in the per-user state family (§3.3 lists that family — readAt,
 *   snooze, pins, tab order, preferences — and deliberately excludes the draft
 *   body). Its reserved future conflict class is `op-stream` (§4): a per-document
 *   ordered op stream sequenced by the Authority, NOT built now.
 *
 * So there is no whole-body merge, no three-way reconcile and no "last write
 * wins" arbitration anywhere in this file. When the op-stream class lands, the
 * action behind `onChange` changes and this component does not.
 *
 * See `CHAT_DRAFT_CLASSIFICATION` in the chat slice for the full record.
 *
 * ---------------------------------------------------------------------------
 * @ REFERENCES ISSUES AND FILES (POD-412)
 * ---------------------------------------------------------------------------
 *
 * The picker is `@/lib/at-mention` — the same hook and the same menu the
 * superagent composer mounts, extracted from it rather than copied. What differs
 * per composer is only the SOURCES, and this one has two:
 *
 *   issues — from the replica the client already holds, matched on ref and on
 *            title, inserting the bare `POD-412` the transcript already
 *            linkifies into a chip and an agent already knows how to resolve.
 *   files  — the session's own checkout, ranked on the server (`files.search`)
 *            so the path list never reaches the browser.
 *
 * The picker takes no keys the composer needs: `mention.onKeyDown` reports
 * whether it consumed one, and the send/newline/IME handling below is reached
 * unchanged whenever it did not.
 *
 * ---------------------------------------------------------------------------
 * `compact` IS THE SUPERAGENT, AND IT WEARS THE SHARED PROMPT BOX (POD-516)
 * ---------------------------------------------------------------------------
 *
 * One mount site passes `compact`: `SuperagentView` → `ChatView` → here. Every
 * other `<ChatView>` in the app (the terminal pane's chat mode, mobile) leaves
 * it false. So `compact` is not a size knob, it is *which product surface this
 * is* — and the Superagent's prompt box has one design, whether the thread is
 * empty or a hundred turns deep.
 *
 * The empty-thread box lives in `SuperagentView`; this is the same box after
 * the first turn. They are ONE implementation: `.prompt-dock` / `.prompt-well` /
 * `.prompt-input` in styles.css, and `usePromptAutoGrow` for the height. What
 * `compact` selects here is nothing but that class set — the structure, the
 * keyboard contract, the @-menu and the send path are shared with the main
 * chat, unchanged.
 *
 * The main chat composer keeps its own ground, its own radius and its own
 * measurement, and every difference between the two paths is one `compact ? :`
 * away from being read. There is no shared "mode" flag inside a single effect
 * or class string: a change to one path cannot reach the other.
 */
export function ChatComposer({
  taRef,
  draft,
  onDraftChange,
  enabled,
  placeholder,
  compact,
  isMobile,
  onSend,
  voice,
  attachments,
  headless,
  turnRunning,
  canInterrupt,
  onInterrupt,
  offer,
  onOfferAction,
  session,
  queuedTotal,
  turnError,
  offlineAsOf,
  autoFocusKey,
  transcriptSettled,
}: {
  taRef: RefObject<HTMLTextAreaElement | null>
  draft: string
  onDraftChange: (text: string) => void
  enabled: boolean
  placeholder: string
  compact: boolean
  isMobile: boolean
  onSend: () => void
  voice: ReturnType<typeof useVoiceInput>
  attachments: UseAttachmentsResult
  headless: boolean
  turnRunning: boolean
  /** A headless turn can be stopped only when a thread is actually driving it. */
  canInterrupt: boolean
  onInterrupt: () => void
  offer: SessionMeta['offer'] | null
  onOfferAction: (prompt: string, offerAt: string) => Promise<void>
  session: SessionMeta | undefined
  queuedTotal: number
  turnError: string | null
  offlineAsOf: number | null
  /** Re-focus on a session switch — the mobile AgentPanel reuses one instance. */
  autoFocusKey: string
  /** False while the initial transcript read is outstanding, so focus is not
   *  grabbed mid-load. */
  transcriptSettled: boolean
}): JSX.Element {
  // Autofocus the composer when the chat view becomes active for a session that
  // can take input, so the user can type straight away. Gated on an enabled
  // composer and a settled transcript. Desktop only: forcing focus on mobile
  // would pop the soft keyboard over the conversation unbidden.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus on session switch / enable
  useEffect(() => {
    if (isMobile || !enabled || !transcriptSettled) return
    taRef.current?.focus()
  }, [autoFocusKey, enabled, transcriptSettled, isMobile])

  // Auto-grow the composer with its content, capped by the max-height (~8
  // lines), after which it scrolls. Runs on every draft change.
  //
  // THE MAIN CHAT'S OWN MEASUREMENT, and only the main chat's: under `compact`
  // the Superagent's box is sized by <PromptAutoGrow> below, which derives its
  // cap from the field's own line-height instead of a hard 176px, so the two
  // must never both write `style.height`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the draft changes
  useEffect(() => {
    if (compact) return
    const ta = taRef.current
    if (!ta) return
    // Measure the content height at height:auto, then restore the previous
    // pixel height and force a reflow BEFORE setting the target — the reflow
    // pins the transition's start value to the old height (measuring at auto
    // otherwise makes the start value 'auto', which cannot interpolate, so
    // the height would snap instead of animate).
    const prev = ta.style.height
    ta.style.height = 'auto'
    // Cap in px (max-h-44 = 176px) so the animated height never fights the
    // CSS clamp; past the cap the textarea scrolls. When empty, scrollHeight
    // includes the (possibly wrapped) placeholder — size to one line instead.
    const cs = getComputedStyle(ta)
    const oneLine =
      Number.parseFloat(cs.lineHeight) +
      Number.parseFloat(cs.paddingTop) +
      Number.parseFloat(cs.paddingBottom)
    const target = ta.value ? Math.min(ta.scrollHeight, 176) : oneLine
    ta.style.height = prev || `${target}px`
    void ta.offsetHeight
    ta.style.height = `${target}px`
  }, [draft, compact])

  // ---- @ context: issues from the replica, files from the session's checkout ----
  // Both lists are capped: the menu is a shortlist, and a menu long enough to
  // scroll past a screen is a search result, which is a different feature.
  const issues = useReplicaIssues()
  const trigger = useAtTrigger({ taRef, enabled })
  const issueOptions = useMemo(
    () => (trigger.query === null ? [] : issueMentions(issues, trigger.query, 5)),
    [issues, trigger.query],
  )
  const fileOptions = useFileMentions({
    query: trigger.query,
    root: session?.cwd,
    machineId: session?.machineId,
    enabled,
  })
  // Issues first, then files: an issue row is the shorter list and the surer
  // match, and a mention that looks like a ref finds no files anyway.
  const options = useMemo(() => [...issueOptions, ...fileOptions], [issueOptions, fileOptions])
  const mention = useAtMenu({ trigger, taRef, value: draft, onChange: onDraftChange, options })

  const sendDisabled =
    !enabled || (!draft.trim() && attachments.attachments.length === 0) || attachments.uploading

  return (
    <div
      // Bottom inset only when the keyboard is CLOSED. With it open (iOS), the home-
      // indicator safe area sits behind the keyboard, so keeping that padding just
      // leaves a dead gap above the keyboard under the composer. --kb-open (0/1) is
      // set from visualViewport by the shell when a soft keyboard is tracked.
      className={cn(
        compact
          ? // The Superagent's box: inset from all four edges with the thread
            // dissolving into the ground above it, instead of a full-bleed bar
            // welded on by a top seam. `.prompt-dock` carries its own bottom
            // safe-area maths, so nothing is restated here.
            'prompt-dock font-mono'
          : cn(
              'border-t border-border px-3 pt-2.5 pb-[calc(10px+(1-var(--kb-open,0))*env(safe-area-inset-bottom,0px))]',
              // Flat Field (POD-159): every chat composer mirrors the native
              // Claude Code / superagent prompt box — mono, CLI `>` prefix, block
              // caret, flat background.
              'bg-background px-3.5 font-mono',
            ),
      )}
      {...attachments.dropHandlers}
    >
      {compact && <PromptAutoGrow taRef={taRef} value={draft} />}
      {/* Agent action offer [spec:SP-c7f1]: the agent's suggested next
          actions, shown only while an offer exists for this session. The
          message sits above compact buttons; a click sends the button's
          predefined prompt as a normal turn (and clears the offer). */}
      {offer && (
        <div className="mb-2">
          <OfferBar
            offer={offer}
            disabled={!enabled}
            onAction={onOfferAction}
            {...(session ? { session } : {})}
          />
        </div>
      )}
      {queuedTotal > 0 && (
        <div className="flex items-center gap-1.5 pb-1.5 text-[11px] text-muted-foreground">
          <Clock size={12} aria-hidden="true" />
          {queuedTotal === 1 ? '1 message queued' : `${queuedTotal} messages queued`} — delivers
          when the agent is ready
        </div>
      )}
      {turnError !== null && (
        <div className="flex items-center gap-1.5 pb-1.5 text-[11px] text-destructive">
          {turnError}
        </div>
      )}
      {offlineAsOf !== null && (
        <div className="flex items-center gap-1.5 pb-1.5 text-[11px] text-muted-foreground">
          <CloudOff size={12} aria-hidden="true" />
          offline copy — as of {new Date(offlineAsOf).toLocaleString()}
        </div>
      )}
      {/* THE FIELD. Under `compact` it is `.prompt-well`: grooved into the
          pane with the same --well-* bevel the command bar's wells use, and
          lifting a step on focus. Carved, not floated — and no yellow focus
          outline, because the yellow block caret inside is already this box's
          "you are typing here" and The Signal Rule pays for that sentence once.
          `.prompt-well` is itself the flex ROW (mark · field · actions), which
          is why the row and the attachment strip share one column child below:
          the well may hold exactly one in-flow item. */}
      <div
        className={cn(
          'relative',
          compact
            ? 'prompt-well'
            : 'flex flex-col gap-0.5 rounded-lg border border-border-strong bg-background px-3 py-1.5 focus-within:border-primary',
        )}
      >
        <AtMentionMenu mention={mention} hint="↑↓ to move · ↵ to insert · esc to dismiss" />
        {attachments.dragOver && (
          <div
            className={cn(
              'pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/5',
              // Follow the well's own corner, or the drop target reads as a
              // second box laid over the field.
              compact && 'rounded-[9px]',
            )}
          >
            <span className="text-sm font-medium text-primary">Drop image to attach</span>
          </div>
        )}
        <input
          ref={attachments.fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={attachments.onFileInputChange}
        />
        <BlockCaret taRef={taRef} value={draft} />
        <div className={cn('flex min-w-0 flex-col gap-0.5', compact && 'flex-1')}>
          <div className="flex items-start gap-2">
            <span
              className={cn(
                'shell-type-primary',
                // `.prompt-mark` lights with the field on focus; the main chat's
                // mark stays dim and is nudged to its own text baseline.
                compact ? 'prompt-mark' : 'flex-none pt-[5px] text-text-dim',
              )}
              aria-hidden="true"
            >
              &gt;
            </span>
            <Textarea
              ref={taRef}
              rows={1}
              placeholder={placeholder}
              className={cn(
                'shell-type-primary min-h-0 resize-none rounded-none border-0 bg-transparent text-foreground caret-transparent outline-none [field-sizing:fixed] focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100 dark:bg-transparent dark:disabled:bg-transparent',
                compact
                  ? // `.prompt-input` owns the height transition, the padding and
                    // the cap (in px, from usePromptAutoGrow) — so no `max-h-*`
                    // here, which would clamp against the animated height, and no
                    // `overflow-y-auto`, which is driven by [data-capped].
                    // Placeholder ink steps up from Faint to Dim: at 10.5px on
                    // this ground Faint is under 4.5:1 and this is the only line
                    // of copy left in the box.
                    'prompt-input min-w-0 flex-1 px-0 shadow-none placeholder:text-text-dim'
                  : 'block max-h-44 w-full overflow-y-auto p-0.5 transition-[height] duration-300 ease-[cubic-bezier(0.25,1,0.35,1)] placeholder:text-text-faint',
              )}
              value={draft}
              disabled={!enabled}
              onChange={(e) => {
                onDraftChange(e.target.value)
                trigger.sync()
              }}
              // Caret moves that are not edits — a click, an arrow, a selection —
              // open and close a mention just as typing does.
              onSelect={trigger.sync}
              onKeyDown={(e) => {
                // The @ menu gets first refusal, and takes ONLY the keys it uses
                // while it is open (never during an IME composition). Everything
                // below is reached unchanged when it declines.
                if (mention.onKeyDown(e)) return
                // Desktop: Enter submits, Shift+Enter is a newline (⌘/Ctrl+Enter
                // still submits). Mobile keeps plain Enter as a newline — the
                // send button submits there.
                // Some browsers clear isComposing on the Enter keydown that
                // confirms a candidate, but continue to report the legacy IME
                // keyCode. In either case, let the composition finish untouched.
                if (
                  e.key === 'Enter' &&
                  (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                ) {
                  return
                }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  onSend()
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
                  e.preventDefault()
                  onSend()
                }
              }}
              onPaste={attachments.onPaste}
            />
            {/* The action cluster is INLINE on the input row (POD-178: a separate
                bottom row read as an unreachable empty line in the box). Compact
                keeps plain ghost icons; the regular composer keeps a primary send
                button, just inline and small. */}
            <div className="flex flex-none items-center gap-0.5 self-end">
              {headless && turnRunning && canInterrupt && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  // Destructive ink stays — stopping a turn is the one act in
                  // this cluster that throws work away. Only the hover ground is
                  // brought onto the cluster's shared idiom.
                  className="size-6 rounded-md text-destructive hover:bg-chip hover:text-destructive [&_svg:not([class*='size-'])]:size-3.5"
                  title="Stop this turn"
                  onClick={onInterrupt}
                >
                  <Square size={16} aria-hidden="true" />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  // One idiom across the cluster: the mic and the stop square
                  // sit either side of this one, and three hover treatments in
                  // a 72px row is what made the box read as assembled rather
                  // than designed.
                  'size-6 rounded-md text-text-dim hover:bg-chip hover:text-text-strong',
                  "[&_svg:not([class*='size-'])]:size-3.5",
                )}
                title="Attach image"
                onClick={attachments.openFilePicker}
              >
                <Paperclip size={16} aria-hidden="true" />
              </Button>
              <VoiceButton voice={voice} />
              {/* THE ARMED SEND. Compact matches the empty-thread box exactly:
                  a quiet glyph in Dim ink while there is nothing to send —
                  legible without hovering, not 40% opacity — that FILLS Superade
                  Yellow over 150ms the moment it can act. Sending is the primary
                  action, which is the one thing The Signal Rule buys yellow for,
                  and it is the only yellow left in this box now that the focus
                  border is gone. */}
              <Button
                type="button"
                size="icon"
                variant={compact ? 'ghost' : 'default'}
                className={cn(
                  compact
                    ? cn(
                        "size-6 rounded-md transition-colors duration-150 motion-reduce:transition-none [&_svg:not([class*='size-'])]:size-3.5",
                        sendDisabled
                          ? 'bg-transparent text-text-dim hover:bg-transparent hover:text-text-dim disabled:bg-transparent disabled:text-text-dim disabled:opacity-100'
                          : 'bg-primary text-primary-foreground hover:bg-primary/80',
                      )
                    : "size-7 rounded-md bg-primary text-primary-foreground hover:bg-primary/80 disabled:bg-secondary disabled:text-muted-foreground/70 disabled:opacity-100 [&_svg:not([class*='size-'])]:size-3.5",
                )}
                disabled={sendDisabled}
                title="Send (Enter)"
                onClick={onSend}
              >
                <ArrowUp size={16} aria-hidden="true" />
              </Button>
            </div>
          </div>
          <AttachmentStrip attachments={attachments.attachments} onRemove={attachments.remove} />
        </div>
      </div>
    </div>
  )
}
