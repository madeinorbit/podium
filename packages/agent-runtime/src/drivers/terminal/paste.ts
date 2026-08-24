/**
 * THE PASTE BOUNDARY (POD-2708). The one place caller text becomes PTY bytes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A LINE INSIDE `deliver`
 * ---------------------------------------------------------------------------
 *
 * The architecture proposal's section 1 — the list of reasons the Agent Runtime
 * exists at all — names this as THE problem, in these words:
 *
 *   "The PTY-as-API is an attack surface. A message body containing ESC[201~
 *    escapes the bracketed paste and executes as keystrokes; sanitizeBody()
 *    strips control characters at render time as the only defense."
 *
 * The defect is not the missing strip. It is WHERE the strip lives. A guard in
 * the message RENDERER protects exactly the callers who route through message
 * rendering; the steward's nudges, the automations drain, an operator body and
 * every future caller of `send()` reach the envelope by other roads and arrive
 * unguarded. So the guard moves to the envelope itself, and the envelope stops
 * being something a caller can assemble: the two markers are module-private,
 * {@link injectionPayload} is the only constructor, and it cannot build one
 * without applying the boundary first.
 *
 * ---------------------------------------------------------------------------
 * WHAT `send()` PROMISES ABOUT ARBITRARY BYTES
 * ---------------------------------------------------------------------------
 *
 * ONE PROMISE, IDENTICAL FOR EVERY ORIGIN — human, controller, steward, mail,
 * auto_continue, system:
 *
 *   Caller text is delivered as CONTENT. No byte of it is ever interpreted by
 *   the receiving CLI as a keystroke or an escape sequence, and in particular
 *   no byte of it can terminate the bracketed paste it is carried in.
 *
 * Deliberately NOT conditioned on who is asking. The old rule made an exemption
 * for the operator ("the human can already type anything into their own
 * terminal, so there is no escalation to prevent") and that reasoning does not
 * survive the move: `send()` types into an ARBITRARY session, not the caller's
 * own, so the operator exemption was a cross-session escalation wearing a
 * byte-faithfulness argument. It also was not the faithfulness it claimed — a
 * human at a keyboard reaches the CLI through its key parser, not through a
 * paste envelope, so the two paths were never equivalent. The human's
 * byte-faithful road is the interactive PTY input stream, which does not come
 * through here.
 *
 * THE CONVERSE HALF OF THE PROMISE MATTERS AS MUCH. Text that is ordinary
 * content arrives byte-for-byte: unicode, emoji, tabs, newlines, code fences,
 * JSON, box drawing, anything a person or an agent would actually write. A
 * guard that mangled normal prompts would be a worse bug than the one it
 * closes, because it would corrupt every turn instead of the crafted ones.
 *
 * ---------------------------------------------------------------------------
 * WHY DROPPING ESC IS A PROOF AND NOT A PATTERN MATCH
 * ---------------------------------------------------------------------------
 *
 * The obvious guard — find `ESC[201~`, delete it — is wrong, and wrong in the
 * way that reads as right. Deleting a match SPLICES its neighbours together,
 * and the neighbours can form a fresh terminator: `ESC[2` + `ESC[201~` + `01~`
 * becomes `ESC[201~` the moment the inner match is removed. A guard like that
 * needs a fixpoint loop and an argument about why the loop terminates.
 *
 * Removing the ESC BYTE CLASS needs neither. A paste terminator requires an
 * ESC; nothing but an ESC produces an ESC; splicing two ESC-free strings cannot
 * manufacture one. So after this pass the terminator is not merely absent, it is
 * UNCONSTRUCTIBLE — and the same argument covers every other escape sequence,
 * the raw CR that would submit half a prompt on the envelope-less path, and the
 * C1 forms of the same controls. That is why the character class, and not the
 * literal, is what gets removed.
 *
 * NEWLINE AND TAB SURVIVE because they are the two control characters that are
 * ordinary content inside a paste, and a prompt is routinely full of both.
 *
 * THE CLASS IS EXACTLY `sanitizeBody`'S. The renderer's strip stays where it is
 * — it has display reasons of its own — and picking the same class makes this
 * pass IDEMPOTENT with respect to it: text that came through the renderer is
 * already a fixpoint here, so nothing rendered is stripped twice and the bytes
 * an agent receives do not depend on how many layers it crossed. The renderer
 * is no longer the defense; it is now a second application of one.
 */

/** The bracketed-paste envelope every harness but a cold grok TUI understands.
 *  MODULE-PRIVATE ON PURPOSE — see the header: a caller holding these can build
 *  an envelope without the boundary, which is the defect being removed. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * Everything a CLI's key parser would read as control rather than content: C0
 * minus TAB and LF, DEL, and the C1 block. Identical to the renderer's class —
 * see the header on why sameness, not strictness, is the property that matters.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g

/**
 * The boundary itself: caller text in, content-only text out.
 *
 * IDEMPOTENT — `f(f(x)) === f(x)` — which is what lets the renderer keep its own
 * strip without the two of them compounding into different bytes.
 */
export function sanitizeForInjection(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '')
}

/** What one turn becomes on the wire to the PTY. */
export interface InjectionPayload {
  /** The exact bytes to write. */
  readonly bytes: string
  /**
   * The prompt content the CLI will actually receive.
   *
   * RETURNED ALONGSIDE THE BYTES, not left for the caller to recompute, because
   * the two must not be allowed to disagree. `deliver` proves a send landed by
   * fingerprinting the harness's `UserPromptSubmit` against the text it sent and
   * by watching the transcript for an echo of it — and the harness saw THIS, not
   * what the caller passed. A watcher armed with the pre-boundary text would
   * fail to match its own accept and report `unverified` for a turn that landed.
   */
  readonly body: string
}

/**
 * Build the bytes for one turn. THE ONLY CONSTRUCTOR OF THE ENVELOPE.
 *
 * `rawFirstTurn` is grok's cold TUI, which ignores bracketed paste until it has
 * seen a native first turn (POD-549/POD-901) and so gets the text as plain
 * keystrokes. IT IS GUARDED IDENTICALLY, and if anything it needs the guard
 * more: with no envelope to break out of, an ESC is simply an interrupt and a CR
 * simply submits, so unsanitized text there is keystroke injection with nothing
 * to escape from at all. The branch chooses an envelope; it does not choose a
 * promise.
 */
export function injectionPayload(
  text: string,
  options: { readonly rawFirstTurn: boolean },
): InjectionPayload {
  const body = sanitizeForInjection(text)
  return { bytes: options.rawFirstTurn ? body : `${PASTE_START}${body}${PASTE_END}`, body }
}

/**
 * Does this text still carry something that could close a paste envelope?
 *
 * The boundary's postcondition, stated so it can be ASSERTED rather than
 * believed — by the tests here, and by any consumer auditing bytes it did not
 * build through {@link injectionPayload}.
 */
export const closesPasteEnvelope = (text: string): boolean => text.includes(PASTE_END)

/**
 * The envelope markers, for tests and for byte-level assertions elsewhere.
 *
 * Exposed as data rather than as the constants themselves so that reading them
 * is obviously an inspection and never a build step: there is still exactly one
 * function in this package that puts text inside them.
 */
export const PASTE_ENVELOPE = { start: PASTE_START, end: PASTE_END } as const
