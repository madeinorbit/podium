import type { AgentRuntimeState } from '@podium/protocol'

/**
 * Normalized cross-agent lifecycle events. Providers translate harness-native
 * payloads (e.g. a Claude Code hook POST body) into these; one shared reducer
 * folds them into AgentRuntimeState. A provider that can only emit a subset
 * degrades to coarser states instead of breaking the model.
 */
export type AgentStateEvent = (
  | { kind: 'session_started' }
  | { kind: 'prompt_submitted' }
  /** Liveness heartbeat (tool use etc.) — anything that proves the agent is computing. */
  | { kind: 'activity' }
  | { kind: 'needs_user'; need: 'question' | 'permission'; summary?: string }
  /** Turn ended cleanly. Verdict (when the provider can classify) excludes
   *  'open_todos' — that upgrade is reducer-owned (it tracks the task counter). */
  | {
      kind: 'turn_completed'
      verdict?: { kind: 'done' | 'question' | 'approval' | 'interrupted'; summary?: string }
    }
  | { kind: 'turn_failed'; errorClass: string; retryable: boolean }
  | { kind: 'compaction'; phase: 'start' | 'end' }
  | { kind: 'task_delta'; delta: 1 | -1 }
  | { kind: 'session_ended' }
) & {
  /** Event-time (ISO 8601) of the source record/hook, when the provider can supply
   *  it (a transcript record's `timestamp`, a rollout file's mtime). The reducer
   *  uses it as the phase `since`, so recency tracks when the agent actually acted —
   *  not when the daemon observed it. This is what keeps a reattach (which replays
   *  the recent transcript tail) from restamping every session to "now". Absent →
   *  the reducer falls back to wall-clock `now` (fine for real-time hooks). */
  at?: string
}

/** What a provider injects at spawn so the harness reports events. */
export interface AgentInstrumentation {
  /** Extra argv appended to the agent CLI. */
  args: string[]
  /** File the daemon must write before spawning (hook/settings config). */
  file?: { path: string; contents: string }
}

export interface AgentStateProvider {
  /** Spawn-time injection wiring the harness's event bus to `endpointUrl`. */
  instrumentation(opts: { endpointUrl: string; settingsPath: string }): AgentInstrumentation
  /** Translate one harness-native payload into zero or more normalized events.
   *  Async because some translations read the transcript (idle classification). */
  translate(payload: unknown): Promise<AgentStateEvent[]>
  /**
   * Events to seed state at spawn, once the CLI is up. Needed because some
   * harnesses emit nothing at interactive boot (Claude Code fires no SessionStart
   * until the first prompt) — but a freshly booted CLI is definitionally sitting
   * at its prompt: idle. A resume can do better and classify the resumed
   * conversation's transcript, restoring a rich verdict before any hook fires.
   */
  bootEvents?(opts: {
    cwd: string
    resumeValue?: string
    /** Test hook; defaults to os.homedir(). */
    homeDir?: string
  }): Promise<AgentStateEvent[]>
}

export type { AgentRuntimeState }
