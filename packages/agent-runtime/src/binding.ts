// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { DriverFamily, DriverId } from '@podium/harness'
import type { AgentRuntimeState, ResumeRef, SessionId } from '@podium/model'
import type { ProviderCursor } from '@podium/protocol'
import type { PendingInteraction } from './interactions.js'

// ---------------------------------------------------------------------------
// Identity: binding, snapshot, archive — three artifacts, three consumer sets
// ---------------------------------------------------------------------------

/**
 * LIVE IDENTITY: who and where the process is. One of the identity triangle's
 * three corners, and the spec is explicit that implementers must not merge them:
 * `binding` = live identity, `snapshot()` = observation bootstrap, `export()` =
 * portable archive.
 */
export interface SessionBinding {
  sessionId: SessionId
  driver: DriverId
  family: DriverFamily
  harness: string
  workdir: string
  /** The harness's own resume ref, captured as EARLY as the harness allows.
   *  Null while the harness has not minted one yet — Codex's rollout files are
   *  lazy, which `DriverCapabilities.resumeRefTiming` declares. */
  resume: ResumeRef | null
  /** The harness account this session runs under, when one was selected. An
   *  opaque harness login name — see `SessionSpec.principal`. */
  principal?: string
  /** Process/scope identity: what `adopt()` matches on after a supervisor
   *  restart. Its CONTENT is driver-private (an abduco socket name, a unix
   *  socket path, a worker pid) — the contract only requires that it round-trips
   *  and identifies EXACTLY one process tree. */
  process: ProcessIdentity
  /** Bumped every time the binding is re-established; the causal envelope's
   *  observer generation is fenced against it. */
  bindingVersion: number
}

export interface ProcessIdentity {
  /** Opaque, driver-private, EXACT. A prefix match here is how ghost sessions
   *  happen. */
  key: string
  /** The cgroup/systemd scope bounding this session's process tree, where the
   *  platform has one. Absent is honest on macOS. */
  scopeUnit?: string
  pid?: number
}

/**
 * OBSERVATION BOOTSTRAP: what the causal contract needs to resume WATCHING.
 * Exactly one snapshot opens an event stream; everything after it is a
 * cursor-fenced live delta.
 */
export interface SessionSnapshot {
  binding: SessionBinding
  state: AgentRuntimeState
  /** Where the transcript reading position sits, so the live tail joins without
   *  a gap and without a replay. */
  cursor: ProviderCursor
  observerGeneration: number
  turnEpoch: number
  /** Open asks at bootstrap. A session that is blocked is, by construction, a
   *  session with an entry here (spec §4). */
  interactions: readonly PendingInteraction[]
  /** The composer's contents, where the driver has a draft. */
  draft?: string
  at: string
}

/**
 * PORTABLE ARCHIVE: what ANOTHER MACHINE needs to resume the CONVERSATION.
 *
 * THE ARCHIVE GUARANTEE (spec §3): an archive is sufficient for
 * `runtime.import` → resume to continue the conversation on any machine with the
 * same harness. It is byte-faithful to the harness-native store (Claude project
 * JSONL, Codex rollouts, opencode sqlite) — deliberately DISTINCT from
 * {@link TranscriptItem}, which is lossy by design for display and search. The
 * two must not be conflated.
 */
export interface SessionArchive {
  harness: string
  /** Opaque-but-VERSIONED per harness: the importing side refuses a version it
   *  does not speak rather than guessing at the layout. */
  formatVersion: number
  resume: ResumeRef
  /** Harness-native files, relative to the archive root. */
  files: readonly ArchiveFile[]
  /** Binding metadata the importer needs to re-home the session (workdir shape,
   *  account, model policy) — never the process identity, which is per-machine. */
  binding: Omit<SessionBinding, 'process' | 'bindingVersion'>
}

export interface ArchiveFile {
  /** Archive-relative path. Never absolute: an absolute path is a promise about
   *  the DESTINATION machine that the source machine cannot make. */
  path: string
  bytes: Uint8Array
}
