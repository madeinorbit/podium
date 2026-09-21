// packages/harness/src/driver/families/turn-error.ts
//
// A TURN THAT FAILED AFTER THE HARNESS MINTED ITS SESSION (1.5).
//
// The conversation exists on disk, so the caller must still learn its id —
// otherwise one interrupted/errored turn orphans the whole thread: no resume
// ref, no transcript binding, and the next turn silently starts a new
// conversation.
//
// ONE definition for every one-shot turn implementation, whatever family runs
// it (codex-json, resume-exec, claude-sdk): the failure shape is a fact about
// turns, not about any protocol. The supervisor's own turn error extends this
// base, so matching on the base sees family-thrown failures too.

/** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
export class HeadlessTurnFailure extends Error {
  constructor(
    message: string,
    readonly harnessSessionId?: string,
  ) {
    super(message)
    this.name = 'HeadlessTurnError'
  }
}
