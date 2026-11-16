/**
 * THE POSTURE CONTRACT'S TYPES, ALONE (POD-6858).
 *
 * docs/design/harness-session-posture.md §4.4–4.7. Product code states what
 * Podium needs to be true of a session (`SessionPosture`, in @podium/protocol);
 * each adapter's `posture` section states how its harness makes that true for
 * one launch mode. Plain data, so the surfaces that carry terms can name them
 * without pulling in the checks in ./posture.ts.
 */
import type { SessionPosture } from '@podium/protocol'
import type { HarnessContext } from './harness-context-types.js'
import type { LaunchFile } from './manifest.js'

/** A JSON value, as a `json-key` home edit writes it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/**
 * Podium's standing facts for one session, built once by the daemon on the
 * harness's own machine (§4.4). Product code never lists these.
 */
export interface PodiumGrants {
  /** The Podium CLI: runs without asking and may reach the daemon. */
  readonly podiumCli: { name: string; path: string }
  /** Where this session's chat attachments are saved. Read-only for the agent. */
  readonly uploadsDir: string
  /** Podium's own MCP servers; their tools need no approval. */
  readonly mcpServers: readonly string[]
}

/** The ways Podium starts a harness process (§4.5). */
export type LaunchMode =
  /** The stock TUI in a PTY. */
  | 'terminal'
  /** A persistent headless process Podium speaks a protocol to. */
  | 'engine'
  /** One process per turn, one-shot exec included. */
  | 'turn'
  /** A stock TUI attached to a running engine. */
  | 'client'

export const LAUNCH_MODES: readonly LaunchMode[] = ['terminal', 'engine', 'turn', 'client']

/** What "set up right" means (§3), by name. */
export const POSTURE_REQUIREMENTS = [
  'workspace-trust',
  'podium-cli',
  'autonomy',
  'quiet-start',
  'podium-material',
] as const
export type PostureRequirement = (typeof POSTURE_REQUIREMENTS)[number]

/** Everything a posture section may read. Pure data: no ambient access. */
export interface PostureRequest {
  readonly mode: LaunchMode
  readonly posture: SessionPosture
  readonly grants: PodiumGrants
  readonly workdir: string
  /** The main checkout when `workdir` is a worktree. */
  readonly repoRoot?: string
  /** Session-scoped folder for generated config files. */
  readonly runtimeDir: string
  /** Home, environment, folders and installed version: the pinned context. */
  readonly context: HarnessContext
}

/** The part of a launch a posture section may add to. */
export interface PostureLaunch {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly files: readonly LaunchFile[]
}

/**
 * An edit to the harness home, for a fact with no per-launch channel (§4.7).
 * `serves`: the requirement that becomes unmet when the edit cannot be made.
 */
export type HomeEdit =
  /** A file Podium owns outright and names as its own. */
  | { kind: 'owned-file'; file: string; contents: string; serves: PostureRequirement }
  /** One key in a file the harness owns. Nothing else in the file changes. */
  | {
      kind: 'json-key'
      file: string
      path: readonly string[]
      value: JsonValue
      serves: PostureRequirement
      /**
       * Create the file, holding only this key, when it does not exist yet.
       * Only for a file in a home Podium owns (an agent home whose config
       * folder Podium selects), never for the person's own file: the harness
       * would create it on its first start anyway, and until then the edit
       * would otherwise go unmet.
       */
      createIfMissing?: true
    }
  /**
   * One string in an array in a TOML file the harness owns, added when the
   * array does not hold it yet. `path` is the table, then the key
   * (`['permission', 'allow']`). Every other line of the file, comments
   * included, stays as it is; a missing key or table is added.
   */
  | {
      kind: 'toml-array-entry'
      file: string
      path: readonly string[]
      value: string
      serves: PostureRequirement
      /**
       * Create the file, holding only this table and key, when it does not
       * exist yet. Unlike `json-key`, also for the person's own file where
       * the operator decided so and a file holding only this table is
       * measured to start the harness exactly like no file (Grok, §4.8).
       */
      createIfMissing?: true
    }

/** A requirement this harness cannot meet in this launch mode, and why. */
export interface UnmetRequirement {
  requirement: PostureRequirement
  reason: string
}

/** What a posture section returns. */
export interface PostureResult {
  readonly launch: PostureLaunch
  /** Edits to the harness home, for facts with no per-launch channel. */
  readonly homeEdits: readonly HomeEdit[]
  /** The harness mode Podium asked for. Not proof of the mode in force. */
  readonly requestedMode: string | null
  /** What this harness cannot do in this launch mode, and why. */
  readonly unmet: readonly UnmetRequirement[]
}

/** An adapter's posture section (`AgentManifest.posture`). */
export type PostureSection = (launch: PostureLaunch, request: PostureRequest) => PostureResult

/**
 * On what terms a harness process runs (§4.6): an adapter's section and the
 * request it answers, or — for a process that runs no agent (a native login
 * pane, a chat-id allocation, a tool-less turn) — the reason, in words.
 */
export type LaunchTerms = { posture: PostureSection; request: PostureRequest } | { noAgent: string }

/** What applying the terms leaves for the daemon to do and report. */
export interface AppliedTerms {
  readonly homeEdits: readonly HomeEdit[]
  readonly requestedMode: string | null
  readonly unmet: readonly UnmetRequirement[]
}
