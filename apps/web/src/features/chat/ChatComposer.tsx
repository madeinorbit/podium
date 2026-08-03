import type { SessionMeta } from '@podium/model'
import type { useVoiceInput } from '@podium/terminal-client-react'
import { ArrowUp, Clock, CloudOff, Paperclip, Square } from 'lucide-react'
import type { JSX, RefObject } from 'react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { BlockCaret } from '@/lib/BlockCaret'
import { cn } from '@/lib/utils'
import { AttachmentStrip } from './AttachmentStrip'
import { OfferBar } from './OfferBar'
import type { UseAttachmentsResult } from './use-attachments'
import { VoiceButton } from './VoiceButton'

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the draft changes
  useEffect(() => {
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
  }, [draft])

  const sendDisabled =
    !enabled || (!draft.trim() && attachments.attachments.length === 0) || attachments.uploading

  return (
    <div
      // Bottom inset only when the keyboard is CLOSED. With it open (iOS), the home-
      // indicator safe area sits behind the keyboard, so keeping that padding just
      // leaves a dead gap above the keyboard under the composer. --kb-open (0/1) is
      // set from visualViewport by the shell when a soft keyboard is tracked.
      className={cn(
        'border-t border-border px-3 pt-2.5 pb-[calc(10px+(1-var(--kb-open,0))*env(safe-area-inset-bottom,0px))]',
        // Flat Field (POD-159): every chat composer mirrors the native
        // Claude Code / superagent prompt box — mono, CLI `>` prefix, block
        // caret, flat background.
        'bg-background px-3.5 font-mono',
      )}
      {...attachments.dropHandlers}
    >
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
      <div className="relative flex flex-col gap-0.5 rounded-lg border border-[#3a3a46] bg-background px-3 py-1.5 focus-within:border-primary">
        {attachments.dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/5">
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
        <div className="flex items-start gap-2">
          <span
            className="flex-none pt-[5px] text-[13px] leading-[1.45] text-[#6c6c78]"
            aria-hidden="true"
          >
            &gt;
          </span>
          <Textarea
            ref={taRef}
            rows={1}
            placeholder={placeholder}
            className="block max-h-44 min-h-0 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0.5 text-[13px] leading-[1.45] text-foreground caret-transparent outline-none transition-[height] duration-300 ease-[cubic-bezier(0.25,1,0.35,1)] [field-sizing:fixed] placeholder:text-[#4d4d59] focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100 dark:bg-transparent dark:disabled:bg-transparent"
            value={draft}
            disabled={!enabled}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
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
                className="size-6 rounded-md text-destructive hover:bg-transparent hover:text-destructive [&_svg:not([class*='size-'])]:size-3.5"
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
                'size-6 rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground',
                "[&_svg:not([class*='size-'])]:size-3.5",
              )}
              title="Attach image"
              onClick={attachments.openFilePicker}
            >
              <Paperclip size={16} aria-hidden="true" />
            </Button>
            <VoiceButton voice={voice} />
            <Button
              type="button"
              size="icon"
              variant={compact ? 'ghost' : 'default'}
              className={cn(
                compact
                  ? "size-6 rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground disabled:bg-transparent disabled:opacity-40 [&_svg:not([class*='size-'])]:size-3.5"
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
      {compact && (
        <div className="flex items-center gap-2 px-1 pt-1.5 text-[10.5px] text-[#4d4d59]">
          <span className="text-[#6c6c78]">⏵⏵ auto-delegate on</span>
          <span>(shift+tab to cycle)</span>
          <span className="ml-auto">? for shortcuts</span>
        </div>
      )}
    </div>
  )
}
