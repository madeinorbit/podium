// apps/daemon/src/claude-sdk-protocol.ts
//
// The wire between the daemon and the Claude Agent SDK host child, and the single
// source of truth for how that child is launched. Deliberately SDK-FREE: this
// module is imported by the daemon's own process, so anything it reaches is
// loaded into the process that supervises every session on the machine. The SDK
// itself is reached only by claude-sdk-host.ts, which never runs here.
//
// WHY A CHILD PROCESS AND NOT A WORKER THREAD. The discovery worker next door is
// a `node:worker_threads` Worker, and that is the right shape for it: its jobs
// are pure and bounded. This one is not. `@anthropic-ai/claude-agent-sdk` is
// third-party code driving a long-running agent, and its failure modes are
// unbounded memory and hard crashes — this epic watched one unbounded search
// reach 3.9GB. A worker thread shares the process's address space and its RSS
// ceiling, so an OOM there still kills the daemon and with it every session on
// the box. Only a separate process gives the daemon something it can lose.

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { HeadlessTurnEvent } from '@podium/protocol'
import type { HeadlessTurnSpec } from './headless-drivers.js'

/** Set on the child's environment so a re-exec of the compiled binary boots the
 *  SDK host instead of the CLI. See scripts/cli-compiled.ts. */
export const CLAUDE_SDK_HOST_ENV = 'PODIUM_CLAUDE_SDK_HOST'

/** Repo-relative path of the child entry, spawned directly when running from source. */
export const CLAUDE_SDK_HOST_ENTRY = 'apps/daemon/src/claude-sdk-host.ts'

/** daemon -> host, one JSON object per line on the child's stdin. */
export type ClaudeSdkHostCommand =
  | { t: 'turn'; spec: HeadlessTurnSpec }
  /**
   * Ask the SDK to wind the turn down gracefully (timeout, or a user interrupt).
   *
   * `requestId` is what makes the answer attributable. Without it an interrupt
   * was a write with no read: the daemon learned nothing about whether the
   * provider had accepted, refused, or never been asked, and every one of those
   * reached the operator as the same silent success.
   */
  | { t: 'interrupt'; requestId?: string }
  | {
      t: 'answer'
      interactionId: string
      decision: 'allow-once' | 'allow-always' | 'deny'
      feedback?: string
    }

/** host -> daemon, one JSON object per line on the child's stdout. */
export type ClaudeSdkHostFrame =
  | { t: 'event'; event: HeadlessTurnEvent }
  /**
   * The harness session id, forwarded THE MOMENT the SDK reports it and before
   * the turn can succeed or fail. This frame is what makes a killed child
   * survivable: the conversation exists on disk from that point on, so a parent
   * that has seen this id can still name it when the child dies mid-turn. Without
   * it an interrupted turn orphans the whole thread — no resume ref, no
   * transcript binding, and the next turn silently starts a new conversation.
   */
  | { t: 'session'; harnessSessionId: string }
  | {
      t: 'permission'
      interactionId: string
      toolName: string
      input?: unknown
      suggestions?: readonly unknown[]
    }
  /**
   * THE PROVIDER'S ANSWER TO ONE `interrupt` COMMAND, and the reason this
   * protocol has a reverse direction for interrupts at all.
   *
   * `accepted` is the SDK's own verdict, never the host's optimism: it is true
   * only once `query.interrupt()` has RESOLVED. A rejection carries `detail`
   * because an interrupt that declined to act is a thing the operator has to be
   * told — a turn that keeps running after a refused stop looks exactly like a
   * turn that ignored them.
   *
   * Absence of this frame is itself meaningful and is NOT the same as
   * `accepted: false`: a host killed mid-wind-down never answers, and the daemon
   * records that as unconfirmed rather than manufacturing either verdict.
   */
  | { t: 'interrupt-ack'; requestId?: string; accepted: boolean; detail?: string }
  /**
   * ONE TOOL CALL, AND LATER ITS RESULT — the pair that makes a headless turn
   * readable after the fact (POD-3050).
   *
   * `status: 'tool'` already told the daemon a tool was running, but a status is
   * a badge: it names no call, carries no input, has no identity, and is gone the
   * moment the next one arrives. A transcript needs the call itself, so these two
   * frames carry what the durable record is made of — the provider's own
   * `tool_use.id`, which is what pairs them, and nothing invented here.
   *
   * They are separate frames rather than `HeadlessTurnEvent` variants on purpose:
   * this is the daemon's private line to its own child, and the durable path they
   * feed is `transcriptDelta`, which already carries transcript items. Widening
   * the public activity union would have changed the wire for every consumer to
   * say something none of them read.
   */
  | { t: 'tool-call'; toolUseId: string; toolName: string; input?: unknown }
  /**
   * `output` is the result text, flattened from whatever block shape the provider
   * used. It is ALWAYS present and may be empty: a tool that printed nothing did
   * run, and an empty result is a fact about it — dropping the frame would leave
   * the call in the transcript looking like it never returned.
   */
  | { t: 'tool-result'; toolUseId: string; output: string; isError?: boolean }
  | { t: 'done'; harnessSessionId: string; output: string }
  | { t: 'error'; message: string; harnessSessionId?: string }

/**
 * Whether `url` is a module inside a bun-compiled standalone binary. Shares the
 * spelling notes of discovery-worker-embed.ts: Bun's virtual filesystem root is
 * `/$bunfs` on POSIX but `B:\~BUN` on Windows, percent-encoded in import.meta.url.
 */
export function isCompiledBunfsUrl(url: string): boolean {
  const u = url.toLowerCase()
  return u.includes('/$bunfs/') || u.includes('~bun') || u.includes('%7ebun')
}

export interface ClaudeSdkHostLaunch {
  cmd: string
  args: string[]
  /** Extra environment the child needs to become the host (compiled binary only). */
  env: Record<string, string>
}

/**
 * How to launch the SDK host from whatever runtime the daemon is itself running
 * under. Two cases, and neither guesses:
 *
 *  - COMPILED (`bun build --compile`): one binary ships and it has no .ts on disk
 *    to hand a child, so the binary re-execs ITSELF with a sentinel in the
 *    environment; scripts/cli-compiled.ts reads that sentinel before it does
 *    anything else and becomes the host. `process.execPath` is the binary.
 *
 *  - FROM SOURCE (bun, or node under the tsx loader): spawn the sibling `.ts`
 *    with `process.execArgv` replayed in front of it. Probed under both: bun
 *    reports `['--conditions=@podium/source']` there and node-under-tsx reports
 *    its preflight/loader/conditions flags, so replaying execArgv is exactly the
 *    set that makes a sibling TypeScript module resolve the same way this one
 *    did. Reconstructing that argument list by hand would be a guess that breaks
 *    the day the daemon's launch command changes.
 */
export function claudeSdkHostLaunch(
  moduleUrl: string = import.meta.url,
  hostPath?: string,
): ClaudeSdkHostLaunch {
  // The sentinel rides BOTH launch shapes, not just the compiled one. The
  // compiled binary needs it to dispatch; the host module needs it to know it was
  // launched as a host rather than merely imported (its unit tests import it for
  // `buildClaudeSdkOptions` and must not start a stdin loop). One variable, one
  // meaning: "this process exists to be the SDK host".
  const env = { [CLAUDE_SDK_HOST_ENV]: '1' }
  if (isCompiledBunfsUrl(moduleUrl)) return { cmd: process.execPath, args: [], env }
  const entry = hostPath ?? fileURLToPath(new URL('./claude-sdk-host.ts', moduleUrl))
  if (runtimeLoadsTypeScript()) {
    return { cmd: process.execPath, args: [...process.execArgv, entry], env }
  }
  return { cmd: process.execPath, args: [...typeScriptLoaderArgs(), entry], env }
}

/** Whether THIS process could import the host's TypeScript if asked. Bun always
 *  can; Node only with a loader attached, which is how the daemon is launched. */
function runtimeLoadsTypeScript(): boolean {
  return Boolean(process.versions.bun) || process.execArgv.some((a) => a.includes('tsx'))
}

/**
 * DEV AND TEST ONLY, and worth stating why it exists rather than leaving it to
 * look like production plumbing.
 *
 * Every way the daemon really ships already loads TypeScript: compiled, under
 * bun, or under tsx. The one caller that does not is a VITEST WORKER — its
 * `execArgv` is the worker's own, carrying no loader, so replaying it produced a
 * child that resolved `claude-sdk-host.ts` and then died on the first `./x.js`
 * specifier inside it. That surfaced in the real-binary smoke test and nowhere in
 * the unit suite, which is the argument for having a real-binary smoke test.
 *
 * The loader is resolved to an ABSOLUTE url from this module, never by bare
 * specifier: the child's cwd is the session's own repository, which has no
 * reason to have tsx installed.
 */
function typeScriptLoaderArgs(): string[] {
  let loader: string
  try {
    loader = createRequire(import.meta.url).resolve('tsx')
  } catch {
    throw new Error(
      'cannot launch the Claude SDK host: this Node process has no TypeScript loader ' +
        'and tsx is not installed. Run the daemon under bun, under tsx, or from the ' +
        'compiled binary.',
    )
  }
  return ['--import', pathToFileURL(loader).href, '--conditions=@podium/source']
}
