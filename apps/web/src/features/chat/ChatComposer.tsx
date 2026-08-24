import type { SessionMeta } from '@podium/model/browser'
import type { useVoiceInput } from '@podium/terminal-client-react'
import { ArrowUp, CloudOff, MessageSquareText, Paperclip, Square, X } from 'lucide-react'
import type { JSX, RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReplicaIssues } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { AtMentionMenu } from '@/lib/at-mention/AtMentionMenu'
import { issueMentions } from '@/lib/at-mention/mention-sources'
import { useAtMenu, useAtTrigger } from '@/lib/at-mention/useAtMention'
import { useFileMentions } from '@/lib/at-mention/useFileMentions'
import { issueAgentKind } from '@/lib/issue-agents'
import { AllConnectorsModelPicker, EffortPicker } from '@/lib/ModelEffortPicker'
import { usePromptAutoGrow } from '@/lib/use-prompt-auto-grow'
import { cn } from '@/lib/utils'
import { AttachmentStrip } from './AttachmentStrip'
import { OfferBar } from './OfferBar'
import type { UseAttachmentsResult } from './use-attachments'
import { chordLabel, useComposerChord } from './use-composer-chord'
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
  turnRunning,
  canInterrupt,
  onInterrupt,
  interruptError,
  offer,
  onOfferAction,
  onOfferDismiss,
  session,
  turnError,
  offlineAsOf,
  attached,
  autoFocusKey,
  transcriptSettled,
  backend,
  onBackendModelChange,
  onBackendEffortChange,
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
  /** A turn is running — native or headless. Shows the stop control. The
   *  composer no longer asks WHICH kind: `headless` used to be here only to gate
   *  that control, and gating it was the bug (POD-1214). */
  turnRunning: boolean
  /** A stop can be ATTEMPTED: a thread is driving the headless turn, or the
   *  native session is live. Arms the double-Escape chord. */
  canInterrupt: boolean
  onInterrupt: () => void
  /** Why the last stop did not take effect (POD-1214). Shown as its own notice:
   *  a turn that is still running after you pressed stop must say so. */
  interruptError?: string | null
  offer: SessionMeta['offer'] | null
  onOfferAction: (prompt: string, offerAt: string) => Promise<void>
  /** "None of these" — clears the offer without sending a turn. */
  onOfferDismiss: (offerAt: string) => Promise<void>
  session: SessionMeta | undefined
  turnError: string | null
  offlineAsOf: number | null
  /** "Ask superagent (BTW)" (POD-1069): the session the NEXT turn will carry a
   *  transcript digest of. Null on every composer but the superagent's. */
  attached?: { label: string; clear: () => void } | null
  /** Re-focus on a session switch — the mobile AgentPanel reuses one instance. */
  autoFocusKey: string
  /** False while the initial transcript read is outstanding, so focus is not
   *  grabbed mid-load. */
  transcriptSettled: boolean
  /** The thread's harness/model/effort (POD-782). Present only for a superagent
   *  thread. `agentKind` is the current connector (frozen, or just picked);
   *  undefined means Auto — follow Settings — and the model menu still lists
   *  every connected agent. */
  backend?: { agentKind: string | undefined; model: string; effort: string }
  onBackendModelChange?: (model: string, agentKind?: string) => void
  onBackendEffortChange?: (effort: string) => void
}): JSX.Element {
  const lastInterruptEscapeAt = useRef<number | null>(null)
  // THE FOCUS CHORD (POD-993). ⌘/ puts the caret here from anywhere in the pane,
  // and the box says so in its corner while it is unfocused and empty — the one
  // thing about a prompt box a reader cannot discover by looking at it. What the
  // corner names is `chordLabel()`, which is ⌘L on the macOS shell: the View menu
  // owns that accelerator and the focused panel already answers it.
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
  const [focused, setFocused] = useState(false)
  const focusField = useCallback(() => {
    taRef.current?.focus()
  }, [taRef])
  useComposerChord(rootEl, focusField)
  /** The main chat's auto-grow memory: the field's line box (fixed for this
   *  mount) and the last height it wrote. See the effect below. */
  const growCache = useRef<{ oneLine: number; lastTarget: number | null } | null>(null)

  // A session switch reuses this composer on mobile. Never let the first Esc
  // from one session arm the second Esc in another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear on session switch
  useEffect(() => {
    lastInterruptEscapeAt.current = null
  }, [autoFocusKey])

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
  //
  // ---------------------------------------------------------------------------
  // THIS EFFECT IS ON THE KEYSTROKE PATH, SO IT PAYS FOR ITSELF TWICE (POD-2045)
  // ---------------------------------------------------------------------------
  //
  // Reading `scrollHeight` after setting `height:auto` forces a synchronous
  // layout of the whole document. On a long transcript that is the single most
  // expensive thing between pressing a key and seeing the character, and this
  // effect used to do it TWICE per keystroke — once to measure, once more to
  // pin the transition's start value — plus a full computed-style parse. On the
  // overwhelming majority of keystrokes the height does not change at all, so
  // all of that bought nothing.
  //
  // Two things are cached, and neither is a guess about the DOM:
  //
  //   the LINE BOX  is a function of font and padding, which are set by the
  //                 class list and cannot change while this composer is mounted;
  //   the TARGET    is compared before writing, and the transition-pinning
  //                 reflow is owed only when the height is genuinely about to
  //                 move — there is nothing to interpolate from otherwise.
  //
  // The measurement itself stays: reading the content height IS the feature.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the draft changes
  useEffect(() => {
    if (compact) return
    const ta = taRef.current
    if (!ta) return
    let cache = growCache.current
    if (!cache) {
      const cs = getComputedStyle(ta)
      cache = {
        oneLine:
          Number.parseFloat(cs.lineHeight) +
          Number.parseFloat(cs.paddingTop) +
          Number.parseFloat(cs.paddingBottom),
        lastTarget: null,
      }
      growCache.current = cache
    }
    // Measure the content height at height:auto. Cap in px (matching
    // `max-h-[150px]` on the field) so the animated height never fights the CSS
    // clamp; past the cap the textarea scrolls. When empty, scrollHeight
    // includes the (possibly wrapped) placeholder — size to one line instead.
    const prev = ta.style.height
    ta.style.height = 'auto'
    const target = ta.value ? Math.min(ta.scrollHeight, 150) : cache.oneLine
    if (Number.isFinite(target) && target === cache.lastTarget) {
      // Same height as last time. Put back what was there and stop: no
      // transition to pin, so no second forced layout.
      ta.style.height = prev || `${target}px`
      return
    }
    cache.lastTarget = target
    // Restore the previous pixel height and force a reflow BEFORE setting the
    // target — the reflow pins the transition's start value to the old height
    // (measuring at auto otherwise makes the start value 'auto', which cannot
    // interpolate, so the height would snap instead of animate).
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

  /**
   * THE ACTION CLUSTER, HOISTED (POD-993) — one definition, two placements.
   *
   * Compact keeps it INLINE beside the field, which is right for a 280px dock
   * where a second row would cost a fifth of the box. The regular composer moves
   * it to its own bottom row, and that is a reversal of POD-178 rather than a
   * drift from it: POD-178 removed a bottom row that was EMPTY apart from the
   * buttons, and read as an unreachable blank line inside the field. The row
   * here is not empty — it carries the send hint on the left and the attachment
   * strip above it — and what it buys is the whole width for the words. Inline,
   * the field gave up ~90px on EVERY line to a cluster that only ever needs the
   * last one, so a wide pane wrapped a prompt three lines early and the box read
   * as narrower than the pane it sits in.
   */
  const actionCluster = (
    <div
      className={cn(
        'flex flex-none items-center',
        // On the floor of a wide well the three controls are the only objects in
        // the row, so they get a real gap rather than the 2px huddle they needed
        // when they were squeezed in beside the field.
        compact ? 'gap-0.5 self-end' : 'gap-2',
      )}
    >
      {/* NOT headless-only (POD-1214). A native session's turn is just as
          stoppable — the server sends its harness's abort key — and gating the
          button on `headless` left the double-Escape chord as the ONLY way to
          stop a claude/codex session from chat, which is a chord nobody can see. */}
      {turnRunning && canInterrupt && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // Destructive ink stays — stopping a turn is the one act in this
          // cluster that throws work away. Only the hover ground is brought onto
          // the cluster's shared idiom.
          className={cn(
            'text-destructive hover:bg-chip hover:text-destructive',
            compact
              ? "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5"
              : "size-7 rounded-[8px] [&_svg:not([class*='size-'])]:size-4",
          )}
          title="Stop this turn"
          aria-label="Stop this turn"
          data-testid="composer-stop"
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
          // One idiom across the cluster: the mic and the stop square sit either
          // side of this one, and three hover treatments in a 72px row is what
          // made the box read as assembled rather than designed.
          'text-text-dim hover:bg-chip hover:text-text-strong',
          compact
            ? "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5"
            : "size-7 rounded-[8px] [&_svg:not([class*='size-'])]:size-4",
        )}
        title="Attach a file"
        onClick={attachments.openFilePicker}
      >
        <Paperclip size={16} aria-hidden="true" />
      </Button>
      <VoiceButton voice={voice} />
      {/* THE ARMED SEND. Compact matches the empty-thread box exactly: a quiet
          glyph in Dim ink while there is nothing to send — legible without
          hovering, not 40% opacity — that FILLS Superade Yellow over 150ms the
          moment it can act. Sending is the primary action, which is the one
          thing The Signal Rule buys yellow for, and it is the only yellow left
          in this box now that the focus border is gone. */}
      <Button
        type="button"
        size="icon"
        // The primary variant owns Superade's yellow silhouette. Keep the whole
        // empty affordance neutral, including that inherited rim, and only opt
        // into primary once the action is armed.
        variant={compact || sendDisabled ? 'ghost' : 'default'}
        className={cn(
          compact
            ? cn(
                "size-6 rounded-md transition-colors duration-150 motion-reduce:transition-none [&_svg:not([class*='size-'])]:size-3.5",
                sendDisabled
                  ? 'bg-transparent text-text-dim hover:bg-transparent hover:text-text-dim disabled:bg-transparent disabled:text-text-dim disabled:opacity-100'
                  : 'bg-primary text-primary-foreground hover:bg-primary/80',
              )
            : cn(
                "size-7 rounded-[8px] transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none [&_svg:not([class*='size-'])]:size-4",
                sendDisabled
                  ? 'bg-chip text-text-faint hover:bg-chip hover:text-text-faint disabled:opacity-100'
                  : // Armed, it lifts a pixel under the pointer rather than
                    // changing colour: the yellow already IS the state, and
                    // dimming the one lit thing in the box to acknowledge a
                    // hover reads as going backwards.
                    'bg-primary text-primary-foreground hover:-translate-y-px hover:bg-primary',
              ),
        )}
        disabled={sendDisabled}
        title="Send (Enter)"
        onClick={onSend}
      >
        <ArrowUp size={16} aria-hidden="true" />
      </Button>
    </div>
  )

  return (
    <div
      // Bottom inset only when the keyboard is CLOSED. With it open (iOS), the home-
      // indicator safe area sits behind the keyboard, so keeping that padding just
      // leaves a dead gap above the keyboard under the composer. --kb-open (0/1) is
      // set from visualViewport by the shell when a soft keyboard is tracked.
      className={cn(
        // `offer-lift-seat`: the composer carries the offer, so an opened fold
        // grows it upwards — and its negative top margin keeps that growth off
        // the feed's books, which rides up by the same pixels instead.
        'offer-lift-seat',
        compact
          ? // The Superagent's box: inset from all four edges with the thread
            // dissolving into the ground above it, instead of a full-bleed bar
            // welded on by a top seam. `.prompt-dock` carries its own bottom
            // safe-area maths, so nothing is restated here.
            'prompt-dock font-mono'
          : cn(
              // The dock is the feed's own gutter, minus ten: 22px each side, so
              // the well's edge sits just inside the column of words it answers
              // and the whole bottom of the sheet reads as one object.
              // No top rule and no surface of its own any more (POD-725): the
              // sheet runs to the bottom edge and the field's own well is the
              // only boundary the design draws. A border here would have cut the
              // document off from the thing it is a reply to.
              //
              // AND NO `font-mono` (POD-993 round 3). POD-159 put the whole dock
              // in the machine voice because the box was imitating a CLI prompt.
              // It is not one now: what you type here is prose, it lands in the
              // feed as prose, and the design sets it in the same 14/24 Geist the
              // transcript is written in. Typing a sentence in a monospace box and
              // watching it arrive in a proportional one is the seam this removes.
              // The micro labels that ARE machine voice — the queue notice, the
              // focus chord — ask for mono themselves.
              'chat-composer-dock px-[22px] pt-2 pb-[calc(18px+(1-var(--kb-open,0))*env(safe-area-inset-bottom,0px))]',
            ),
      )}
      ref={setRootEl}
      // NO DROP HANDLERS HERE ANY MORE (POD-1595) — ChatView mounts them on the
      // whole chat surface instead. They lived on this dock, which is a ~70px
      // strip at the bottom of the pane, so "drag a file into the conversation"
      // only worked if you released it inside that strip and did nothing at all
      // — not even showing a target — over the ~90% of the surface a person
      // actually aims at. Mounting them in both places would double every drop.
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
            onDismiss={onOfferDismiss}
            {...(session ? { session } : {})}
          />
        </div>
      )}
      {(turnError !== null ||
        (interruptError !== null && interruptError !== undefined) ||
        offlineAsOf !== null ||
        attached) && (
        <div className="composer-notices" aria-live="polite">
          {/* The attachment leads: it is the only notice here that describes
              what the NEXT send will carry, and it is dismissible. */}
          {attached && (
            <div className="composer-notice" data-notice="attached">
              {/* The context menu's own icon, not the attachment paperclip:
                  this rides a conversation, not a file. */}
              <MessageSquareText size={12} aria-hidden="true" />
              <strong>Context</strong>
              <span className="min-w-0 truncate">{attached.label}</span>
              <button
                type="button"
                data-pressable
                className="ml-auto rounded-[4px] px-1 text-text-dim hover:bg-chip hover:text-text-strong"
                title="Don't send this session's transcript"
                aria-label={`Remove ${attached.label} from this message`}
                onClick={attached.clear}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </div>
          )}
          {turnError !== null && (
            <div
              className="composer-notice composer-notice--error"
              data-notice="error"
              role="alert"
            >
              <strong>Not sent</strong>
              <span>{turnError}</span>
            </div>
          )}
          {/* "Not stopped", deliberately not "Not sent": the failure being
              reported is that the agent is STILL RUNNING. */}
          {interruptError !== null && interruptError !== undefined && (
            <div
              className="composer-notice composer-notice--error"
              data-notice="interrupt-error"
              role="alert"
            >
              <strong>Not stopped</strong>
              <span>{interruptError}</span>
            </div>
          )}
          {offlineAsOf !== null && (
            <div className="composer-notice" data-notice="offline">
              <CloudOff size={12} aria-hidden="true" />
              <strong>Offline copy</strong>
              <span>as of {new Date(offlineAsOf).toLocaleString()}</span>
            </div>
          )}
        </div>
      )}
      {/* THE FIELD. Under `compact` it is `.prompt-well`: grooved into the
          pane with the same --well-* bevel the command bar's wells use, and
          lifting a step on focus. Carved, not floated — and no yellow focus
          outline, because focus is navigation state rather than a request for
          operator action.
          `.prompt-well` is itself the flex ROW (mark · field · actions), which
          is why the row and the attachment strip share one column child below:
          the well may hold exactly one in-flow item. */}
      <div
        className={cn(
          'relative',
          compact
            ? 'prompt-well'
            : 'chat-composer-well flex flex-col gap-1.5 rounded-[12px] pt-[11px] pr-3 pb-[9px] pl-[15px]',
        )}
      >
        <AtMentionMenu mention={mention} hint="↑↓ to move · ↵ to insert · esc to dismiss" />
        {/* Shown only while the box is unfocused AND empty, so it can never land
            on the operator's own words — a placeholder line never reaches it.
            It names what it does, not just the keys: a bare chord in the corner of
            a text field is a puzzle, and the two extra words cost nothing at the
            moment the field is empty. */}
        {!compact && (
          <span
            className="composer-chord"
            data-show={!focused && draft === '' && enabled ? 'true' : undefined}
            data-testid="composer-chord"
            aria-hidden="true"
          >
            {chordLabel()} to focus
          </span>
        )}
        <input
          ref={attachments.fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={attachments.onFileInputChange}
        />
        <div className={cn('flex min-w-0 flex-col gap-0.5', compact && 'flex-1')}>
          <div className="flex items-start gap-2">
            <Textarea
              ref={taRef}
              rows={1}
              placeholder={placeholder}
              className={cn(
                // `shell-type-primary` is the SHELL's reading size (13/18) and it
                // belongs to the narrow dock, which is shell chrome. The wide
                // composer sets its own 14/24 below — the transcript's size —
                // and cannot do that with this class also in play: both are
                // single-class selectors, so the winner is whichever Tailwind
                // emits last rather than whichever we meant.
                'min-h-0 resize-none rounded-none border-0 bg-transparent text-foreground caret-foreground outline-none [field-sizing:fixed] focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100 dark:bg-transparent dark:disabled:bg-transparent',
                compact && 'shell-type-primary',
                compact
                  ? // `.prompt-input` owns the height transition, the padding and
                    // the cap (in px, from usePromptAutoGrow) — so no `max-h-*`
                    // here, which would clamp against the animated height, and no
                    // `overflow-y-auto`, which is driven by [data-capped].
                    // Placeholder ink steps up from Faint to Dim: at 10.5px on
                    // this ground Faint is under 4.5:1 and this is the only line
                    // of copy left in the box.
                    'prompt-input min-w-0 flex-1 px-0 shadow-none placeholder:text-text-dim'
                  : // THE FIELD IS THE FULL WIDTH OF THE WELL AND NOTHING ELSE
                    // (POD-993 round 2). The cluster no longer sits beside the
                    // words — it dropped to the floor below them — so there is
                    // nothing left to centre against and the padding that used
                    // to do that centring is gone. What remains is a plain
                    // 14/24 line box: the same reading size as the transcript
                    // above it, so what you type looks like what you sent.
                    'block max-h-[150px] w-full overflow-y-auto p-0 text-[14px] leading-6 transition-[height] duration-200 ease-[cubic-bezier(0.25,1,0.35,1)] placeholder:text-text-faint motion-reduce:transition-none',
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
                // Transcript-chat equivalent of the native CLI interrupt: two
                // Esc presses in an EMPTY composer cancel the active turn. The
                // first press is consumed so a surrounding sheet/menu cannot
                // close in the middle of the chord. Any other key disarms it.
                if (e.key === 'Escape' && canInterrupt && draft === '') {
                  e.preventDefault()
                  e.stopPropagation()
                  const now = Date.now()
                  if (
                    lastInterruptEscapeAt.current !== null &&
                    now - lastInterruptEscapeAt.current <= 600
                  ) {
                    lastInterruptEscapeAt.current = null
                    onInterrupt()
                  } else {
                    lastInterruptEscapeAt.current = now
                  }
                  return
                }
                lastInterruptEscapeAt.current = null
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
              onFocus={() => {
                setFocused(true)
              }}
              onBlur={() => {
                setFocused(false)
              }}
            />
            {/* Compact only: the dock's box has no room for a second row. */}
            {compact && actionCluster}
          </div>
          <AttachmentStrip attachments={attachments.attachments} onRemove={attachments.remove} />
          {/* THE BOTTOM ROW (POD-993). The field takes the whole width and the
              cluster sits under it, right-aligned. It briefly carried a
              send/newline caption; that is gone — the chord chip in the corner
              is the one hint this box needs, and it appears only when it can
              still be acted on. */}
          {!compact && <div className="composer-row">{actionCluster}</div>}
        </div>
      </div>
      {backend && onBackendModelChange && onBackendEffortChange && (
        <BackendRail
          backend={backend}
          machineId={session?.machineId}
          onModelChange={onBackendModelChange}
          onEffortChange={onBackendEffortChange}
        />
      )}
    </div>
  )
}

/**
 * THE PROMPT BOX'S BACKEND RAIL (POD-782) — which model this thread thinks with,
 * stated where you are about to use it.
 *
 * It sits UNDER the well, not inside it. POD-178 removed a second row from
 * inside the box because an empty line below the caret reads as unreachable
 * text; this row is outside that boundary, is never empty, and is never a text
 * target — so it does not reintroduce that problem. It is also the shape the
 * native CLIs use, which is the shape this box has been imitating since POD-159.
 *
 * QUIET BY DEFAULT. Both pills read `auto` until someone chooses otherwise, and
 * `auto` is not a placeholder — it is the real, correct answer: "whatever
 * Settings → Superagent says". A person who never touches this row is not
 * missing a decision, and the row's ink says so by staying at Dim.
 *
 * The model menu lists every connector Podium can run, not just the Settings
 * default. Picking a model from another CLI switches the thread's harness on
 * the next send (#199). Auto returns both connector and model to Settings.
 *
 * The choice is PER THREAD and persists: it rides the next turn's mutation and
 * the server writes it onto the thread, so it survives a reload and holds for
 * every later turn until changed. That is why there is no Save — the send IS
 * the save, and a picker that needed confirming would make choosing a model a
 * two-step act in the one place it should be a one-step one.
 */
function BackendRail({
  backend,
  machineId,
  onModelChange,
  onEffortChange,
}: {
  backend: { agentKind: string | undefined; model: string; effort: string }
  machineId?: SessionMeta['machineId']
  onModelChange: (model: string, agentKind?: string) => void
  onEffortChange: (effort: string) => void
}): JSX.Element {
  const agentKind = issueAgentKind(backend.agentKind)
  return (
    <div className="mt-1.5 flex items-center gap-1 px-0.5" data-testid="composer-backend">
      <AllConnectorsModelPicker
        agentKind={agentKind ?? undefined}
        machineId={machineId}
        value={backend.model}
        onChange={(pick) => onModelChange(pick.model, pick.agentKind)}
        variant="pill"
      />
      {agentKind ? (
        <EffortPicker
          agentKind={agentKind}
          machineId={machineId}
          model={backend.model}
          value={backend.effort}
          onChange={onEffortChange}
          variant="pill"
        />
      ) : null}
    </div>
  )
}
