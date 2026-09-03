/**
 * THE PASTE BOUNDARY, SERVER SIDE (POD-2708).
 *
 * The authoritative statement of this boundary — what `send()` promises about
 * arbitrary bytes, why the promise cannot vary by origin, and why removing the
 * ESC character class is a proof rather than a pattern match — lives with the
 * driver, in `packages/agent-runtime/src/drivers/terminal/paste.ts`. Read it
 * there; this file is deliberately the same rule and not a second opinion.
 *
 * WHY A SECOND COPY EXISTS AT ALL. It mirrors, exactly, the duplication the
 * driver's own header already declares: the injection MECHANICS were ported to
 * the driver while `inbox.ts` stayed authoritative for the flag-off path, so
 * until W4 retires the server's copy there are two places on the live write
 * path that put caller text inside a bracketed paste. A boundary applied at
 * only one of them is a boundary that ships behind a feature flag, and the live
 * path today is the other one — `SessionInbox.typeText` is what the steward's
 * nudges and the automations drain reach, and neither of those has ever passed
 * through message rendering.
 *
 * A THIRD BUILDER EXISTS AND IS NOT COVERED: `packages/composer` exports the two
 * markers publicly and wraps text in them without a strip. It ships dark, so it
 * is not the live hole this closes, but it is the copy the next person reaches
 * for — filed as POD-2733 rather than fixed here.
 *
 * THE CLASS IS THE RENDERER'S CLASS, which is now stated HERE and borrowed there
 * rather than the other way round. `sanitizeBody` in `../messages/render.ts` is
 * the same function under its display-facing name; it keeps its call site, but it
 * has stopped being the place the rule is defined, because a rule defined in a
 * rendering layer is a rule every non-rendering caller can miss.
 */

/** The bracketed-paste envelope. MODULE-PRIVATE: a caller holding these can
 *  build an envelope without the boundary, which is the defect being removed. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** C0 minus TAB and LF, DEL, and the C1 block — everything a CLI's key parser
 *  would read as control rather than content. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g

/** Caller text in, content-only text out. Idempotent, so applying it at both the
 *  renderer and the injection point yields the same bytes as applying it once. */
export function sanitizeForInjection(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '')
}

/**
 * Build the bytes for one typed turn. THE ONLY CONSTRUCTOR OF THE ENVELOPE on
 * this side.
 *
 * `rawFirstTurn` is grok's cold TUI, which ignores bracketed paste until a native
 * first turn (POD-549/POD-901). It is guarded identically — with no envelope to
 * break out of, an unsanitized ESC is just an interrupt and an unsanitized CR
 * just submits, so that path needs the boundary at least as much.
 */
export function injectionPayload(text: string, options: { rawFirstTurn: boolean }): string {
  const body = sanitizeForInjection(text)
  return options.rawFirstTurn ? body : `${PASTE_START}${body}${PASTE_END}`
}

/** The boundary's postcondition, stated so tests can assert it rather than
 *  believe it: no text that has crossed the boundary can close a paste. */
export const closesPasteEnvelope = (text: string): boolean => text.includes(PASTE_END)
