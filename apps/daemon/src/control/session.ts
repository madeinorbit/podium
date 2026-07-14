import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type AgentSession,
  abducoHasSessionAsync,
  agentStateProviderFor,
  attachAbducoAgent,
  attachTmuxAgent,
  killAbducoSessionAsync,
  killTmuxServerAsync,
  type LaunchFile,
  spawnAbducoAgent,
  spawnAgent,
  spawnTmuxAgent,
  tmuxHasSessionAsync,
} from '@podium/agent-bridge'
import { AGENT_CAPABILITIES, type AgentKind } from '@podium/protocol'
import { resolveInstanceId } from '@podium/runtime/config'
import { countFrame } from '../loop-attribution'
import type { Tier } from '../output-scheduler'
import type { ReattachControl, SpawnControl } from '../session-observers'
import { removeSessionUploads } from '../session-uploads'
import type { ControlHandlers, DaemonContext } from './context'
import { sourceForRead } from './transcripts'

/**
 * Env vars bound into EVERY spawned agent so its `podium` CLI can reach the
 * daemon's loopback relay for this exact session. PODIUM_SESSION_ID is bound at
 * spawn (never a CLI arg the agent could spoof); PODIUM_AGENT_RELAY is the relay
 * URL with the session id baked into the path (agentRelay.endpointFor(sessionId)).
 * Only the new name is written — never the legacy PODIUM_ISSUE_RELAY (read-side
 * tolerance for in-flight sessions lives in resolveAgentRelay, not here). [spec:SP-b85a]
 * Pure so it's unit-testable without standing up the daemon.
 */
export function agentRelayEnv(
  sessionId: string,
  endpoint: string,
  instanceId: string = resolveInstanceId(),
): Record<string, string> {
  // PODIUM_SESSION_ID is a deliberate informational/identity var: the `podium`
  // CLI reads the session id from PODIUM_AGENT_RELAY's path, so this isn't consumed
  // by the relay path today — it's exposed for the agent itself and future consumers.
  return {
    PODIUM_INSTANCE: instanceId,
    PODIUM_SESSION_INSTANCE: instanceId,
    PODIUM_SESSION_ID: sessionId,
    PODIUM_AGENT_RELAY: endpoint,
  }
}

/** Merge the server-resolved session env (managed credentials, #216) under
 *  Podium's own per-session bindings. Podium's win a collision on purpose: an
 *  injected credential must never be able to shadow the agent-relay wiring.
 *  The result is an OVERLAY — the PTY layer layers it over the full process.env. */
export function spawnEnv(opts: {
  sessionEnv?: Record<string, string>
  harnessEnv?: Record<string, string>
  podiumEnv: Record<string, string>
}): Record<string, string> {
  return { ...(opts.sessionEnv ?? {}), ...(opts.harnessEnv ?? {}), ...opts.podiumEnv }
}

export function materializeLaunchFiles(files: LaunchFile[] | undefined): void {
  for (const file of files ?? []) {
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.contents, { mode: 0o600 })
  }
}

function instructionRuntimeDir(ctx: DaemonContext, sessionId: string): string {
  return join(ctx.settingsDir, 'session-instructions', sessionId)
}

function removeSessionInstructions(ctx: DaemonContext, sessionId: string): void {
  rmSync(instructionRuntimeDir(ctx, sessionId), { recursive: true, force: true })
}

export function wireBridge(
  ctx: DaemonContext,
  sessionId: string,
  session: AgentSession,
  agentKind: AgentKind,
  durableLabel: string,
): void {
  ctx.bridges.set(sessionId, session)
  ctx.durableLabels.set(sessionId, durableLabel)
  session.onFrame((frame) => {
    countFrame(frame.data.length)
    ctx.outputScheduler.enqueue(sessionId, frame.data)
  })
  // Codex sets its OSC title to the cwd basename (+ a spinner glyph that churns at
  // frame-rate), which would clobber the real title the codex observer derives
  // (capabilities.oscTitle: false). Every other harness sets a meaningful OSC
  // title, so forward it for them.
  if (AGENT_CAPABILITIES[agentKind].oscTitle) {
    session.onTitle((title) => ctx.send({ type: 'title', sessionId, title }))
  }
  session.onExit((code) => {
    ctx.bridges.delete(sessionId)
    ctx.durableLabels.delete(sessionId)
    ctx.outputScheduler.remove(sessionId)
    ctx.sessionCwdTracker.clear(sessionId)
    ctx.primeInjector.reset(sessionId)
    // The agent's gone (as far as this bridge knows) — stop its observers and
    // its (now frozen) transcript tail.
    ctx.observers.clearSession(sessionId)
    // The attach CLIENT exiting is NOT the AGENT exiting. disposeAll() on a
    // daemon shutdown/redeploy SIGKILLs the client; a user detach or a client
    // crash do the same. For a durable backend the master + agent live on in
    // their own systemd scope (the whole point of abduco) — so reporting
    // agentExit here would persist a live session as 'exited', and boot never
    // reattaches an 'exited' row, orphaning a still-running agent. Only a
    // vanished master is a real exit. (`abducoHasSession` runs `abduco`, which
    // reaps the socket as it lists, so a just-exited master reads as gone.)
    const label = durableLabel
    void (async () => {
      if (ctx.backend === 'abduco' && (await abducoHasSessionAsync(label))) return
      if (ctx.backend === 'tmux' && (await tmuxHasSessionAsync(label))) return
      // The agent has truly exited (master is gone). Uploads are one-shot prompt
      // inputs that were already consumed before the agent finished processing
      // them, so it's safe to remove the per-session upload dir on any real exit
      // (natural finish, hibernate, or kill). kill also calls removeSessionUploads
      // directly, so the two are harmlessly idempotent (rmSync force:true is a no-op
      // on a missing dir). The hourly TTL sweep remains a backstop for edge cases.
      removeSessionUploads(sessionId)
      removeSessionInstructions(ctx, sessionId)
      ctx.send({ type: 'agentExit', sessionId, code })
    })()
  })
}

function spawn(ctx: DaemonContext, msg: SpawnControl): void {
  try {
    const spawnStartedAt = Date.now()
    const runtimeDir = instructionRuntimeDir(ctx, msg.sessionId)
    const cmd = ctx.launch(msg.agentKind, {
      cwd: msg.cwd,
      podiumSessionId: msg.sessionId,
      ...(msg.resume ? { resume: msg.resume } : {}),
      ...(msg.model ? { model: msg.model } : {}),
      ...(msg.effort ? { effort: msg.effort } : {}),
      ...(msg.initialPrompt ? { initialPrompt: msg.initialPrompt } : {}),
      ...(msg.instructions ? { instructions: msg.instructions } : {}),
      runtimeDir,
      ...(msg.env ? { env: msg.env } : {}),
    })
    materializeLaunchFiles(cmd.files)
    const label = msg.durableLabel ?? ctx.durableLabelFor(msg.sessionId)
    const provider = agentStateProviderFor(msg.agentKind)
    let extraArgs: string[] = []
    let instrumentationEnv: Record<string, string> = {}
    if (provider) {
      mkdirSync(ctx.settingsDir, { recursive: true })
      const instr = provider.instrumentation({
        endpointUrl: ctx.hookEndpointFor(msg.sessionId),
        settingsPath: join(ctx.settingsDir, `${msg.sessionId}.json`),
        // Absent = the setting's default (on) — an older server that doesn't
        // send the field still gets the product default [spec:SP-a04d].
        seedTheme: msg.seedCliTheme ?? true,
      })
      if (instr.file) writeFileSync(instr.file.path, instr.file.contents)
      extraArgs = instr.args
      instrumentationEnv = instr.env ?? {}
    }
    const spawnOpts = {
      label,
      cmd: cmd.cmd,
      args: [...cmd.args, ...extraArgs],
      cwd: cmd.cwd,
      cols: msg.geometry.cols,
      rows: msg.geometry.rows,
      env: spawnEnv({
        // Server-resolved managed credential / environment (SP-6454, #216).
        sessionEnv: msg.env,
        harnessEnv: cmd.env,
        podiumEnv: {
          // Bind the loopback agent-relay + session id into every agent's env so its
          // `podium` CLI can reach the daemon for this exact session.
          ...agentRelayEnv(msg.sessionId, ctx.agentRelayEndpointFor(msg.sessionId), ctx.instanceId),
          ...(ctx.homeDir ? { HOME: ctx.homeDir } : {}),
          // Subagent model rides as env — Claude Code reads it; harmless elsewhere.
          ...(msg.subagentModel ? { CLAUDE_CODE_SUBAGENT_MODEL: msg.subagentModel } : {}),
          // Globally-installed hooks are env-gated per session by their adapter.
          // Commands exit immediately when absent, so non-Podium runs are untouched.
          ...instrumentationEnv,
        },
      }),
    }
    const session =
      ctx.backend === 'abduco'
        ? spawnAbducoAgent(spawnOpts)
        : ctx.backend === 'tmux'
          ? spawnTmuxAgent(spawnOpts)
          : spawnAgent(spawnOpts)
    wireBridge(ctx, msg.sessionId, session, msg.agentKind, label)
    // Stand up the agent-state tracker, harness observer, resume transcript tail
    // and seeded phase. A fresh spawn's CLI isn't up yet, so seed on the first
    // frame. Same call on reattach keeps the two paths from drifting.
    ctx.observers.initSessionObservers(msg, session, provider, {
      seedOnFrame: true,
      startedAtMs: spawnStartedAt,
    })
    ctx.send({
      type: 'bind',
      sessionId: msg.sessionId,
      cmd: cmd.cmd,
      cwd: cmd.cwd,
      agentKind: msg.agentKind,
      geometry: msg.geometry,
    })
  } catch (err) {
    removeSessionInstructions(ctx, msg.sessionId)
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

// Reattach is the hot path on (re)connect: a burst of ~30 arrives at once. Each is
// independent, so handle them off the synchronous message dispatch — async existence
// checks (never a blocking fork+exec on the loop), idempotent (a reconnect re-sends
// reattach for sessions we already hold — re-confirm the bind instead of spawning a
// duplicate client), and gated so the spawn fan-out can't fork everything in one tick.
async function handleReattach(ctx: DaemonContext, msg: ReattachControl): Promise<void> {
  const existing = ctx.bridges.get(msg.sessionId)
  if (existing) {
    const cmd =
      ctx.backend === 'tmux'
        ? `tmux -L ${msg.durableLabel} attach`
        : `abduco -a ${msg.durableLabel}`
    ctx.send({
      type: 'bind',
      sessionId: msg.sessionId,
      cmd,
      cwd: msg.cwd,
      agentKind: msg.agentKind,
      geometry: msg.geometry,
    })
    existing.redraw()
    // Re-push agent state for the same reason we re-seed the transcript below: a
    // freshly restarted SERVER (the daemon survived) starts with NO agentState for
    // this session, and an idle survivor fires no hook to re-establish it — so it
    // would fall through the home board's `live → working` fallback and read as
    // WORKING. We still hold the live tracker, so resend its current phase. Skip
    // 'unknown' (nothing to assert) — a cold tracker is re-seeded by the fresh-bridge
    // branch below, not here.
    const state = ctx.observers.trackedState(msg.sessionId)
    if (state && state.phase !== 'unknown') {
      ctx.send({ type: 'agentState', sessionId: msg.sessionId, state })
    }
    // Re-seed the transcript even though we already hold the bridge: a freshly
    // restarted SERVER (the daemon survived) has an empty per-session buffer, and
    // this already-held branch otherwise does no transcript work, so chat would
    // stay blank. The live tail (if any) only re-emits on its NEXT file change, so
    // read the newest window now and push it as a reset delta. Best-effort; a read
    // failure just leaves the buffer to refill from live deltas.
    void (async () => {
      try {
        const source = await sourceForRead(ctx, msg)
        const res = await source.readSlice({ direction: 'before', limit: 2000 })
        if (res.items.length > 0) {
          ctx.send({
            type: 'transcriptDelta',
            sessionId: msg.sessionId,
            items: res.items,
            reset: true,
            ...(res.tail ? { tail: res.tail } : {}),
          })
        }
      } catch (err) {
        console.warn(`[podium] reattach re-seed failed for ${msg.sessionId}:`, err)
      }
    })()
    return
  }
  await ctx.reattachGate(async () => {
    if (ctx.bridges.has(msg.sessionId)) return // raced with another reattach for this id
    // A reattached shell sits idle at its prompt and ignores the SIGWINCH repaint
    // nudge, so without a Ctrl-L it shows blank until the user types. TUIs repaint
    // on resize, so only shells take the hard path.
    const attach = {
      label: msg.durableLabel,
      cols: msg.geometry.cols,
      rows: msg.geometry.rows,
      hardRepaint: msg.agentKind === 'shell',
    }
    let found: { session: AgentSession; cmd: string } | undefined
    // Backend-agnostic: try whichever durable host owns the label, so sessions
    // created under tmux before an abduco upgrade still reattach (no flag day).
    if (ctx.backend !== 'none' && (await abducoHasSessionAsync(msg.durableLabel))) {
      found = { session: attachAbducoAgent(attach), cmd: `abduco -a ${msg.durableLabel}` }
    } else if (ctx.backend !== 'none' && (await tmuxHasSessionAsync(msg.durableLabel))) {
      found = { session: attachTmuxAgent(attach), cmd: `tmux -L ${msg.durableLabel} attach` }
    }
    if (!found) {
      ctx.send({
        type: 'reattachFailed',
        sessionId: msg.sessionId,
        reason: ctx.backend === 'none' ? 'durable backend unavailable' : 'session not found',
      })
      return
    }
    wireBridge(ctx, msg.sessionId, found.session, msg.agentKind, msg.durableLabel)
    // The settings file from the original spawn still points at our fixed port,
    // so a reattached agent keeps reporting. A fresh daemon (post-redeploy) lost
    // all in-memory per-session state — rebuild it via the same path spawn uses.
    // A survivor is already at its prompt and fires no hook until the user acts,
    // so seed immediately (an idle session would otherwise read 'unknown' →
    // 'working') and re-tail its transcript (else chat stays empty while the
    // native view still has scrollback).
    ctx.observers.initSessionObservers(msg, found.session, agentStateProviderFor(msg.agentKind), {
      seedOnFrame: false,
    })
    ctx.send({
      type: 'bind',
      sessionId: msg.sessionId,
      cmd: found.cmd,
      cwd: msg.cwd,
      agentKind: msg.agentKind,
      geometry: msg.geometry,
    })
  })
}

export const sessionHandlers: Pick<
  ControlHandlers,
  'spawn' | 'reattach' | 'kill' | 'input' | 'resize' | 'redraw' | 'sessionPriority'
> = {
  spawn,
  reattach: (ctx, msg) => {
    void handleReattach(ctx, msg)
  },
  kill: (ctx, msg) => {
    const session = ctx.bridges.get(msg.sessionId)
    ctx.observers.clearSession(msg.sessionId)
    if (session) {
      session.dispose()
      ctx.bridges.delete(msg.sessionId)
      ctx.outputScheduler.remove(msg.sessionId)
    }
    // Reap the durable host unconditionally — NOT only when a bridge exists.
    // After a daemon restart a session can be live server-side with no local
    // bridge (attachDaemon only re-binds 'reconnecting' sessions); if kill
    // skipped the reap there, hibernate/kill would leave the abduco/tmux
    // master (and its agent) running. Both reapers are cheap no-ops when the
    // label isn't theirs. Async twins (audit P0-4): the sync reapers fork+exec
    // `abduco`/`tmux` on the loop, and kills arrive in bursts (superagent,
    // auto-hibernation) — serializing those would stall every other session.
    if (ctx.backend !== 'none') {
      const durableLabel =
        msg.durableLabel ??
        ctx.durableLabels.get(msg.sessionId) ??
        ctx.durableLabelFor(msg.sessionId)
      void killAbducoSessionAsync(durableLabel)
      void killTmuxServerAsync(durableLabel)
    }
    ctx.durableLabels.delete(msg.sessionId)
    removeSessionUploads(msg.sessionId)
    removeSessionInstructions(ctx, msg.sessionId)
  },
  input: (ctx, msg) => {
    ctx.bridges.get(msg.sessionId)?.write(msg.data)
  },
  resize: (ctx, msg) => {
    ctx.bridges.get(msg.sessionId)?.resize(msg.cols, msg.rows)
  },
  redraw: (ctx, msg) => {
    ctx.bridges.get(msg.sessionId)?.redraw()
  },
  sessionPriority: (ctx, msg) => {
    ctx.outputScheduler.setPriority(msg.sessionId, msg.priority as Tier)
  },
}
