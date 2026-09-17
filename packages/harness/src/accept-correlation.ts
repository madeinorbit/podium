import type { TranscriptItem } from '@podium/model'
import { claudePromptHookFingerprint } from './agent-state/claude-code.js'
import type { TerminalAcceptCorrelation } from './manifest.js'

/** The same signal session-observers uses to anchor Claude turn epochs.
 * Content blocks, tool-result exclusion and injected context stripping remain
 * owned by claudePromptHookFingerprint. */
export const claudeHookAcceptCorrelation: TerminalAcceptCorrelation<unknown> = {
  accepts(payload) {
    if (typeof payload !== 'object' || payload === null) return false
    const record = payload as Record<string, unknown>
    return (record.hook_event_name ?? record.hookEventName) === 'UserPromptSubmit'
  },
  fingerprint: claudePromptHookFingerprint,
  fingerprintText: (text) => claudePromptHookFingerprint({ prompt: text }),
}

/**
 * THE ECHO FINGERPRINT (POD-4055), and it is deliberately NOT the hook's.
 *
 * The hook path can hash a structured payload because Claude hands it one.
 * The echo is a recorded transcript item, so what has to be absorbed is the
 * set of transformations the RECORDERS apply between the bytes we typed and
 * the row they write. Those are enumerable, and they are all whitespace:
 * `codexRecordToItems` trims, `contentToText` joins multi-block content with
 * newlines, and the several JSONL codecs re-wrap.
 *
 * WHAT THIS BUYS AND WHAT IT LETS THROUGH, stated because a tolerance nobody
 * wrote down is a tolerance nobody can review. It buys immunity to trimming
 * and to block joins. It lets through two submitted texts that differ ONLY in
 * whitespace — an overlapping pair differing just in wrapping can cross-credit.
 * That is a far narrower hole than the counter it replaces, which credited any
 * user turn from any source at all.
 *
 * WHAT IT DOES NOT DO IS MATCH A SUBSTRING. An echo carrying the full text
 * plus anything else is a different turn, and a truncated echo is not this
 * turn. Both stay `unverified`, which is true. Note this is safe precisely
 * because nothing here reads a SCREEN: every producer of these items reads a
 * structured record (codex/grok/cursor/pi rollout JSONL, opencode's own
 * SQLite rows, Claude's transcript tail), so a TUI's `> ` prompt marker never
 * reaches this comparison. An anchored match against a painted line would be
 * wrong; against a recorded one it is exactly right.
 */
const echoFingerprint = (text: string): string | null => {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  // FAIL CLOSED on an empty item, for the reason the hook path fails closed on
  // an unfingerprintable payload: an item carrying no text cannot attribute
  // anything, and crediting an arbitrary waiter for it is the mis-credit this
  // whole mechanism exists to prevent.
  return collapsed.length > 0 ? collapsed : null
}

/** An interrupt marker is a user action, but never a typed prompt. */
export const transcriptEchoAcceptCorrelation: TerminalAcceptCorrelation<TranscriptItem> = {
  accepts: (item) => item.role === 'user' && item.event !== 'interrupt',
  fingerprint: (item) => echoFingerprint(item.text),
  fingerprintText: echoFingerprint,
}
