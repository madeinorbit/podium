// packages/harness/src/driver/families/server-family.ts
//
// THE UNIFORM SERVER-FAMILY SHAPE (1.5, spec §5).
//
// The supervisor composes every server family behind one contract: launch a
// session, rebind a survivor from its journal, describe the engine for logs,
// and expose the journal facts adoption and teardown need. Per-family
// differences (journal entry shapes, probe material, display names) are
// mapped HERE by each family's session module — the supervisor never
// branches on which family it holds.
//
// This is the "driver union" the daemon's machine runtime used to carry as a
// closed set of harness names. It is now a list of these, built once per
// supervisor generation, with driver ids (mechanism vocabulary) as the only
// identities that cross it.

import type { HarnessAgent, ResumeRef, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { ProcessIdentity, SessionBinding } from '../binding.js'
import type { AgentSessionHandle, RuntimeDriver } from '../driver.js'
import type { RuntimeEvent } from '../events.js'

/**
 * The frame-stream ports every server-family session adapter needs from
 * whoever supervises it. The supervisor owns the wire (send sink, the one
 * bind builder, timing stages, the mail continuation); the families own the
 * translation. One shape for all four families — a second speaker of any of
 * these protocols reuses it without edits.
 */
export interface ServerSessionFramePorts {
  send(msg: DaemonMessage): void
  /**
   * Emit the session-live bind. A server-family session has no terminal at
   * launch, so the bind is bare.
   */
  emitBind(input: {
    sessionId: SessionId
    cmd: string
    cwd: string
    agentKind: HarnessAgent
    driverId: string
    configureFields: string[]
    attachKinds: Array<'client' | 'engine'>
  }): void
  /** Timing stages: session-ready once, then every contract event. */
  sessionReady(binding: AgentSessionHandle['binding']): void
  traceRuntimeEvent(binding: AgentSessionHandle['binding'], event: RuntimeEvent): void
  /** Fetch issue context after a successfully completed provider turn. */
  startMailContinuation(
    handle: AgentSessionHandle,
    isCurrent: () => boolean,
  ): (event: RuntimeEvent) => void
}

/** The launch facts every server family takes: identity, directory, model. */
export interface ServerFamilyLaunch {
  sessionId: SessionId
  cwd: string
  model?: string
  effort?: string
  env?: Readonly<Record<string, string>>
  initialPrompt?: string
}

/**
 * The journal facts adoption and teardown need, normalized across families.
 * The entry SHAPES stay per-family (their journals); this is the projection
 * the supervisor reads: where the session works, which process is its
 * engine, and — for loopback transports — the credentialed probe that proves
 * a live port is still THIS session's server.
 */
export interface ServerFamilyJournalEntry {
  readonly workdir: string
  readonly process: ProcessIdentity
  readonly bindingVersion: number
  /**
   * The harness conversation this session continues, where the family can
   * name it. The reattach arm refuses a row that asks for a DIFFERENT one
   * before adopting anything (POD-4612 — the check the bespoke Claude arm
   * carried): rebinding the wrong conversation under a session id is worse
   * than failing the reattach. Absent ⇒ no check, never a guess.
   */
  readonly resume?: ResumeRef
  readonly probe?: {
    readonly baseUrl: string
    readonly secret: string
    readonly username?: string
    readonly healthPath?: string
  }
}

/**
 * ONE SERVER FAMILY, as the supervisor composes it. Backed by the family's
 * session runtime (`create*SessionRuntime`); the supervisor only ever talks
 * through this shape.
 */
export interface ServerFamilyRuntime {
  readonly driver: RuntimeDriver
  /** Human label for adoption logs (`codex app-server`, `opencode serve`). */
  readonly describe: string
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  bindings(): readonly SessionBinding[]
  /** Start a session on this family and put it behind the contract. The
   *  result is the family's own business; the supervisor reads the handle
   *  back through {@link handleFor}. */
  launch(input: ServerFamilyLaunch): Promise<unknown>
  /**
   * Start a session that CONTINUES an existing harness conversation, under the
   * server's session id. Absent ⇒ this family resumes only from its own
   * journal ({@link adoptFromJournal}), and a spawn carrying a resume ref it
   * cannot honour creates instead — unchanged behaviour for the vendor
   * servers. The Claude stream engine declares it: its conversation outlives
   * any engine, so `--resume` works from the ref alone.
   */
  launchResumed?(input: ServerFamilyLaunch, resume: ResumeRef): Promise<unknown>
  /** Re-bind a session after a supervisor restart, from the journal alone. */
  adoptFromJournal(sessionId: SessionId): Promise<AgentSessionHandle | undefined>
  /** The journal's normalized facts, or `undefined` when this family does
   *  not hold the session and never journalled it. */
  journalEntry(sessionId: SessionId): ServerFamilyJournalEntry | undefined
  clearJournal(sessionId: SessionId): void
  reportOomKill(sessionId: SessionId, scopeUnit?: string): void
  dispose(): void
}
