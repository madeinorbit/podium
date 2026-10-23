/**
 * How a mail-handling turn must END [POD-604, POD-2070] — the rule the server
 * appends to every envelope an agent acts on, and the text the client strips
 * from the rendered body. One copy here, so a rewording cannot leave the client
 * stripping a rule the server no longer sends (the parse bug POD-2070 fixed).
 *
 * Mail only ever lands on an IDLE session — a running one queues until its turn
 * ends — so almost every delivery interrupts an agent that has just finished
 * and reported. Two things the human relies on are then at risk:
 *
 *  - the SUMMARY: the chat folds each mail to one line (POD-993), so the answer
 *    stays readable right above it. POD-604 had every mail turn restate that
 *    summary, and a burst of five mails then pushed it off screen five times
 *    over (POD-2070). The rule is now the opposite: say nothing when the mail
 *    needed nothing or only a reply, one sentence when the agent acted on it,
 *    and more only when it changes what the human was told.
 *  - the OFFER is not lost — a `mail`-origin turn deliberately does not clear it
 *    (`userOpenedTurn`, POD-118) — but `podium offer` REPLACES rather than
 *    stacks, so an agent that posts a mail-flavoured card destroys the
 *    "ready to merge" one the human was coming back to click. The instruction is
 *    therefore to leave it alone unless the mail changed the decision itself.
 */
export const TURN_CLOSE_RULE =
  `[when you finish with this mail: the human already has your last answer — do not repeat it. ` +
  `If the mail needed nothing from you, or only a reply, end your turn without ` +
  `a message; the reply goes through \`podium mail reply\` and is never echoed here. If you did ` +
  `something about it beyond replying, say what in one plain sentence. If it changes what you ` +
  `told the human, say clearly what changed and what now holds.]\n` +
  `[your standing offer survived this mail: leave it as it is unless this mail changed what the ` +
  `human must decide. Check the issue stage still matches reality before you stop.]\n`

// LEGACY(remove-after: 2027-04): POD-604's wording, still inside envelopes stored in older transcripts; removing it shows that rule as mail body text again.
export const LEGACY_TURN_CLOSE_RULE =
  `[before you go idle: a human returning here reads only your LAST message. In one or two plain ` +
  `sentences say who mailed you, what they wanted and what you did — then repeat, below that, the ` +
  `summary of your own work this interrupted, so it is still what they see.]\n` +
  `[your standing offer survived this mail: leave it, or re-post it unchanged — never replace it ` +
  `with one about the mail. Check the issue stage still matches reality before you stop.]\n`
