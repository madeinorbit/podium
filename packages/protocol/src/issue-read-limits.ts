/**
 * Output caps the bounded issue READ commands apply server-side.
 *
 * Declared here because two sides must agree on them: the server enforces them,
 * and the CLI names the cap (and the flag that raises it) in its truncation
 * footer. A cap the notice quotes wrongly is worse than no notice, so neither
 * side hardcodes its own copy.
 *
 * CARRIED FORWARD from main's `packages/protocol/src/commands.ts` (635cd759).
 * That file was retired by the rewrite because `packages/commands` replaced its
 * command-definition machinery (CommandDef/defineCommands/ISSUE_COMMAND_NAMES).
 * These three constants are unrelated to that machinery — they are shared
 * configuration — so they were ported here rather than deleted with it.
 * Deleting them would have silently dropped main's truncation footer, whose
 * whole point is that the number it prints is the number the server used.
 */
export const ISSUE_TREE_DEFAULT_MAX_DEPTH = 3
export const ISSUE_TREE_DEFAULT_MAX_NODES = 100
export const ISSUE_EVENTS_DEFAULT_LIMIT = 200

/**
 * The page `podium mail inbox` and `podium issue mail inbox` ask for, and the
 * ceiling `--limit` may raise it to [PDM-407].
 *
 * A MAILBOX CAP HAS A DIRECTION, and picking the wrong one is what made a busy
 * mailbox unreadable: capped with the ascending scan the delivery path wants,
 * both listings returned the OLDEST page, so the unread count climbed while
 * every row the reader could see was one it had already read. The newest page is
 * the one a reader is asking for.
 */
export const MAIL_INBOX_DEFAULT_LIMIT = 50
export const MAIL_INBOX_MAX_LIMIT = 500

/**
 * The banner a FULL mailbox page carries — at the TOP as well as the bottom.
 *
 * Both ends on purpose. A long listing is cut by whatever displays it (a
 * terminal, an agent's tool-output cap), and a footer is the first thing such a
 * cut removes — so a footer alone would be missing in exactly the case it exists
 * to report. Shared between the two inbox CLIs so the number in the notice is
 * always the number the caller actually sent.
 */
export function mailInboxTruncationNotice(limit: number, command: string): string[] {
  return [
    `TRUNCATED: showing the newest ${limit}; older messages are not listed.`,
    // `--limit=<n>`, NOT `--limit <n>`, and the `=` is load-bearing [PDM-427].
    // `flagsFromZodShape` calls a key value-LESS iff its schema accepts `true` and
    // rejects every VALUE_PROBE, and `z.coerce.number()` does exactly that: it
    // coerces true to 1 and rejects 'a-value'. So on the issue CLI a numeric flag
    // parses as a boolean, the space form drops its value, and the number falls
    // through to the next POSITIONAL — which on `mail` is the issue ref, turning
    // `mail inbox --limit 500` into a lookup for issue 500. The `=` form assigns
    // regardless of that classification and works on BOTH inbox CLIs.
    //
    // A banner that recommends a form its own CLI ignores is the defect PDM-427
    // was filed for, wearing a new mouth — and this banner is NEW guidance, so it
    // would have shipped that defect rather than inherited it.
    `  Widen with: ${command} --limit=<n> (max ${MAIL_INBOX_MAX_LIMIT}).`,
  ]
}
