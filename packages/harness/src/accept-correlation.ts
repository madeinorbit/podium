import type { HarnessRef, TranscriptItem } from '@podium/model'
import { claudePromptHookFingerprint } from './adapters/claude-code/state.js'
import type { TerminalAcceptCorrelation, TerminalEchoCorrelation } from './manifest.js'

/**
 * Claude's `UserPromptSubmit`, correlated by content. NOT A RECEIPT (POD-4905,
 * spec §3.3): measured on 2.1.284, the hook fired for a prompt a SIGKILL then
 * left out of the history. The terminal driver reads it only for the program's
 * own prompt id (POD-4841); turn tracking reads the hook elsewhere.
 * Content blocks, tool-result exclusion and injected context stripping remain
 * owned by claudePromptHookFingerprint.
 */
export const claudeHookAcceptCorrelation: TerminalAcceptCorrelation<unknown> = {
  accepts(payload) {
    if (typeof payload !== 'object' || payload === null) return false
    const record = payload as Record<string, unknown>
    return (record.hook_event_name ?? record.hookEventName) === 'UserPromptSubmit'
  },
  fingerprint: claudePromptHookFingerprint,
  fingerprintText: (text) => claudePromptHookFingerprint({ prompt: text }),
  harnessRef(payload): HarnessRef | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined
    const promptId = (payload as Record<string, unknown>).prompt_id
    return typeof promptId === 'string' && promptId.length > 0
      ? [{ kind: 'claude-prompt', id: promptId }]
      : undefined
  },
}

/**
 * THE ID OF THE PODIUM MESSAGE A TEXT IS, or null (spec §5.1, POD-4860).
 *
 * The server renders a wrapped message as `[podium message <id> · …]`, the
 * body, and `[end podium message <id>]`. A text is that message when the
 * closing line ends it and the same id's head starts a line above it. Other
 * lines may come first: the drivers type each attachment's path on its own
 * line ahead of the text, and text left in the input box is submitted in
 * front of the paste.
 *
 * ONLY THE TEXT'S OWN FRAME. Bodies are not escaped, so a mail that quotes
 * another mail's frame carries that id inside its own; every quoted id sits
 * above the outer closing line and never counts. An id anywhere else — a
 * person mentioning a frame, or a frame followed by more words — proves
 * nothing. The server's transcript-echo confirmation applies the same rule
 * (`apps/server/src/modules/messages/service.ts`, `echoedFrameId`).
 *
 * Read on the text we type as well as on the entry recorded: a typed text
 * that is a frame is a wrapped message, confirmed by its id alone.
 */
export function podiumFrameId(text: string): string | null {
  const entry = text.trimEnd()
  const id = /\[end podium message (msg_[0-9a-f-]+)\]$/i.exec(entry)?.[1]
  if (!id) return null
  const head = `[podium message ${id} · `
  return entry.startsWith(head) || entry.includes(`\n${head}`) ? id : null
}

/**
 * THE ITEM AS IT WAS TYPED, where a recorder moved part of it out of the text
 * (POD-4774). The terminal driver types attachments as their paths, one per
 * line, ahead of the prompt. Claude records a pasted image path as an image
 * block plus a `[Image: source: <path>]` marker, and its transcript mapper
 * lifts those paths into `toolPaths` and strips them from `text` — so the
 * echo of `"<path>\nlook at this"` is `{ text: 'look at this', toolPaths:
 * [path] }`. Putting the lifted paths back in front, in order, is the typed
 * form again. Only user items carrying lifted paths are touched; no recorder
 * sets `toolPaths` on a user item for any other reason.
 */
const typedForm = (item: TranscriptItem): string =>
  item.toolPaths?.length ? [...item.toolPaths, item.text].join('\n') : item.text

/**
 * A PROMPT ENTRY OF A PROGRAM'S HISTORY, AND HOW ITS TEXT MAY DIFFER FROM WHAT
 * WAS TYPED (spec §2, §5.3, §7).
 *
 * Display role alone cannot override a reader's explicit prompt exclusion;
 * interrupts remain excluded for readers predating the prompt-entry flag.
 * `textMatches`, when given, is the program's measured tolerance and switches
 * order-plus-text credit on for it; without one only a frame id can confirm.
 */
export function promptEchoCorrelation(
  textMatches?: (submitted: string, recorded: string) => boolean,
): TerminalEchoCorrelation {
  return {
    accepts: (item) =>
      item.role === 'user' &&
      item.event !== 'interrupt' &&
      item.promptEntry !== false &&
      item.queued !== true,
    typedText: typedForm,
    ...(textMatches ? { textMatches } : {}),
  }
}

/** Frame ids only: for programs whose text tolerance is not measured (Cursor,
 *  Pi, the fixture) a person's own words are never credited by order. */
export const transcriptEchoAcceptCorrelation: TerminalEchoCorrelation = promptEchoCorrelation()

/**
 * Claude Code 2.1.284 terminal S7 (POD-4862): a tab is recorded as four
 * spaces, each CR and CRLF as LF, and U+200B is removed; everything else is
 * kept exactly. The reader trims the record's outer whitespace, so the typed
 * text is trimmed too. An empty prompt cannot prove a send.
 */
export function claudePromptTextMatches(submitted: string, recorded: string): boolean {
  const typed = submitted
    .replace(/\t/g, '    ')
    .replace(/\r\n?/g, '\n')
    .replace(/\u200b/g, '')
    .trim()
  return typed.length > 0 && typed === recorded.trim()
}

/** Grok 1.0.44 terminal S7 (POD-4865): recorded exactly; the reader trims the
 *  chunk's outer whitespace (POD-4875). An empty prompt cannot prove a send. */
export function grokPromptTextMatches(submitted: string, recorded: string): boolean {
  const typed = submitted.trim()
  return typed.length > 0 && typed === recorded.trim()
}
