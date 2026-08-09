/**
 * Long-running relay for the browser e2e harness (tests/e2e/browser/*.browser.e2e.ts).
 * Like serve.ts, but:
 *   - registers THIS repo in an isolated state dir, so its main worktree shows in the
 *     sidebar (sessions surface under a worktree whose path === the session cwd);
 *   - launches a real shell for `shell` sessions (wide output → reflow tests) and the
 *     keyecho echo jig for claude/codex kinds (deterministic keyboard/mouse fidelity).
 *
 * Run: bun --conditions=@podium/source tests/e2e/serve-harness.ts
 *      (the @podium/source condition resolves workspace packages to TS source; no build)
 * Port: PORT (default 8799). Health: GET /health. The playwright.config webServer starts
 * this automatically (harness only — package/web/mobile builds live in browser-lane);
 * the specs connect via `?server=ws://localhost:8799`.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @podium/harness is EMPTY — POD-396 took the PTY half to @podium/pty and
// POD-397 the harness half to @podium/harness, and the barrel deliberately
// re-exports NOTHING. This harness was still importing from it, so EVERY browser
// e2e spec failed at webServer start with "Export named 'agentLaunchCommand' not
// found in module …/agent-bridge/src/index.ts". Red on issue/279-integration before
// POD-382 branched off it (proved at the branch point: neither file is in this
// branch's diff), and three import lines from being runnable — see POD-382's report.
import {
  agentLaunchCommand,
  ConversationDiscoveryCache,
  type LaunchOptions,
  type LaunchSpec,
} from '@podium/harness'
import type { AgentKind } from '@podium/model'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { ensurePodiumCodexHooks } from '../../apps/daemon/src/codex-hooks'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { runIndexRefreshJob, runMemoryBreakdownJob } from '../../apps/daemon/src/discovery-jobs'
import type { WorkerJob } from '../../apps/daemon/src/discovery-worker'
import { DiscoveryWorkerClient, type WorkerLike } from '../../apps/daemon/src/worker-client'
import { inProcessMachinePrincipal } from '../../apps/server/src/gateway/daemon-mux'
import { startServer } from '../../apps/server/src/server'
import type { SessionStore } from '../../apps/server/src/store'
import { writeCodexStartupFixture } from './codex-fixture'
import {
  applyHarnessEnv,
  applyRealAgentCodexEnv,
  harnessPidFile,
  reapHarnessSessions,
  reapStaleHarnessDirs,
} from './harness-env'

/** THIS HOST's machine id (POD-318) — read from `<stateDir>/machine.id`, the same
 *  file the server and the split-mode daemon read. There is no `'local'` constant
 *  any more; a machine id is minted material.
 *
 *  A FUNCTION, not a module-level constant: these harnesses point PODIUM_STATE_DIR
 *  at an isolated directory AFTER the imports run, and a constant would have read
 *  (and minted into) the real state dir before that happened. */
const hostMachineId = (): string => readOrCreateLocalMachineId()

/**
 * The browser harness keeps discovery jobs INLINE on its main thread so test runs do not
 * depend on worker-loader behavior. The live daemon still uses the real spawned worker;
 * this is harness-only.
 */
function inlineWorkerClient(): DiscoveryWorkerClient {
  return new DiscoveryWorkerClient({
    spawn: (): WorkerLike => {
      const handlers: Array<(m: unknown) => void> = []
      let cache: ConversationDiscoveryCache | undefined
      const indexCache = (cachePath?: string): ConversationDiscoveryCache => {
        if (!cache) cache = new ConversationDiscoveryCache(cachePath)
        return cache
      }
      return {
        postMessage(m: unknown) {
          const job = m as WorkerJob
          void (async () => {
            try {
              const value =
                job.kind === 'memoryBreakdown'
                  ? runMemoryBreakdownJob(job.input)
                  : await runIndexRefreshJob(job.input, indexCache(job.input.cachePath))
              for (const h of handlers) h({ id: job.id, ok: true, value })
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err)
              for (const h of handlers) h({ id: job.id, ok: false, error })
            }
          })()
        },
        on(ev, cb) {
          if (ev === 'message') handlers.push(cb)
        },
        terminate() {
          cache = undefined
        },
      }
    },
  })
}

const PORT = Number(process.env.PORT ?? 8799)
const KEYECHO_CLI = fileURLToPath(new URL('../keyecho/src/cli.tsx', import.meta.url))
const KEYECHO_PKG = fileURLToPath(new URL('../keyecho', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')

// Reap leftovers from a previous hard-killed run, then isolate this run's state +
// abduco/tmux sockets in a per-port dir (never touches the user's ~/.podium or
// real sessions). globalTeardown reaps the same dir after the suite.
reapHarnessSessions(PORT)
// Also sweep ABANDONED sibling ports (an ad-hoc run SIGKILLed days ago leaves its
// abduco masters parked under /tmp/podium-e2e-<other-port> that no same-port run
// will ever revisit) — POD-107.
reapStaleHarnessDirs()
const { stateDir } = applyHarnessEnv(PORT)

// A scratch repo WITH a linked worktree, at a deterministic per-port path so specs
// can compute it (tmpdir()/zz-podium-e2e-repo-<PORT>; the zz- prefix keeps it
// sorted BEHIND the real repo, so specs that hover "the first worktree row"
// keep browsing this repo's tree). Scanning THIS repo (unlike
// REPO_ROOT, which is often itself a linked worktree and scans as a single entry)
// yields a main worktree + a sibling — the multi-worktree sidebar that the
// worktree-follow specs need a session to move between.
const SCRATCH_REPO = join(tmpdir(), `zz-podium-e2e-repo-${PORT}`)
const SCRATCH_FEAT = `${SCRATCH_REPO}-feat`
rmSync(SCRATCH_REPO, { recursive: true, force: true })
const E2E_TARGET_ID = 'e2e-target'
const E2E_TARGET_REPO = `${SCRATCH_REPO}-target`
const E2E_ORIGIN = 'https://e2e.invalid/shared.git'
rmSync(SCRATCH_FEAT, { recursive: true, force: true })
rmSync(E2E_TARGET_REPO, { recursive: true, force: true })
mkdirSync(SCRATCH_REPO, { recursive: true })
const git = (args: string[], cwd: string): void => {
  execFileSync('git', ['-c', 'user.email=e2e@podium', '-c', 'user.name=e2e', ...args], { cwd })
}
git(['init', '-q', '-b', 'main'], SCRATCH_REPO)
writeFileSync(join(SCRATCH_REPO, 'README.md'), 'e2e scratch repo\n')
git(['add', '.'], SCRATCH_REPO)
git(['commit', '-q', '-m', 'init'], SCRATCH_REPO)
git(['worktree', 'add', '-q', SCRATCH_FEAT, '-b', 'e2e-feat'], SCRATCH_REPO)
if (process.env.PODIUM_E2E_HANDOFF === '1' || process.env.PODIUM_E2E_MULTI_MACHINE === '1') {
  git(['remote', 'add', 'origin', E2E_ORIGIN], SCRATCH_REPO)
  git(['clone', '-q', SCRATCH_REPO, E2E_TARGET_REPO], SCRATCH_REPO)
}

writeFileSync(join(stateDir, 'repos.json'), JSON.stringify([REPO_ROOT, SCRATCH_REPO]))
// Pre-pick the deployment mode so the setup gate (SetupGate → /setup/config →
// needsSetup) doesn't block the workspace: the harness IS an all-in-one server.
// Without this every browser spec lands on the first-run SetupView.
// Browser specs exercise these pre-release surfaces directly, so the isolated
// harness locks them on without changing their production default-off behavior.
const E2E_FEATURES = {
  'command-palette': true,
  'git-panel': true,
  'messages-panel': true,
  'tab-splitting': true,
  'session-handoff': true,
  workflows: true,
  specs: true,
  automations: true,
  notifications: true,
}
writeFileSync(
  join(stateDir, 'config.json'),
  JSON.stringify({ mode: 'all-in-one', features: E2E_FEATURES }),
)

// shell -> real shell (wide output for reflow tests); everything else -> keyecho jig.
// PODIUM_E2E_REAL_AGENTS=1 launches the REAL claude/codex CLI instead (opt-in,
// uses your account/quota) for specs that need genuine agent behaviour (hooks,
// transcripts, paste handling). Default stays deterministic.
const REAL_AGENTS = process.env.PODIUM_E2E_REAL_AGENTS === '1'
const NATIVE_LOGIN_FIXTURE = process.env.PODIUM_E2E_NATIVE_LOGIN === '1'
const nativeLoginHome = NATIVE_LOGIN_FIXTURE ? join(stateDir, 'native-login-home') : undefined
if (nativeLoginHome) {
  const binDir = join(nativeLoginHome, '.local', 'bin')
  mkdirSync(binDir, { recursive: true })
  const codex = join(binDir, 'codex')
  writeFileSync(
    codex,
    `#!/bin/sh\n[ "$1" = "login" ] || exit 2\nwhile true; do echo "Native Codex login ready"; sleep 1; done\n`,
  )
  chmodSync(codex, 0o755)
}
// Real Codex must never see the developer's rollout history: otherwise the
// connect-time discovery snapshot publishes thousands of unrelated threads and
// repeatedly stalls this in-process harness. The private home copies only auth.
const realAgentCodexEnv = REAL_AGENTS ? applyRealAgentCodexEnv(PORT) : undefined
if (realAgentCodexEnv) {
  // Seed only non-secret startup state after its private home exists: every
  // harness worktree is trusted and personality onboarding is already resolved.
  writeCodexStartupFixture(realAgentCodexEnv.codexHomeDir, [REPO_ROOT, SCRATCH_REPO, SCRATCH_FEAT])
  await ensurePodiumCodexHooks({ homeDir: realAgentCodexEnv.discoveryHomeDir })
}

/**
 * PODIUM_E2E_SILENT_START=<ms> — every spawn is a child that prints NOTHING for
 * that long, then starts behaving (POD-385).
 *
 * This is the shape of a CLI that updates itself on launch: attached, alive,
 * and pixel-identical to a dead session until it finally paints. Nothing about
 * it is grok-specific — the harness only has to produce silence, which is the
 * one thing the panel has to survive.
 */
const SILENT_START_MS = Number(process.env.PODIUM_E2E_SILENT_START ?? 0)

const launchLogFile = join(stateDir, 'launch-log.jsonl')
const launch = (kind: AgentKind, opts: LaunchOptions): LaunchSpec => {
  appendFileSync(
    launchLogFile,
    JSON.stringify({
      agentKind: kind,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
    }) + '\n',
  )
  if (SILENT_START_MS > 0) {
    return {
      cmd: process.execPath,
      args: [
        '-e',
        // Silent, then a prompt and a live process: the panel must show the
        // wait for the first stretch and get out of the way for the second.
        `setTimeout(() => { process.stdout.write('booted $ '); setInterval(() => {}, 1000) }, ${SILENT_START_MS})`,
      ],
      cwd: REPO_ROOT,
    }
  }
  if (kind === 'shell' || REAL_AGENTS) {
    const spec = agentLaunchCommand(kind, opts)
    // The isolated CODEX_HOME contains only the reviewed Podium hook. This
    // documented automation bypass is test-only and never changes production trust.
    if (REAL_AGENTS && kind === 'codex') {
      return { ...spec, args: ['--dangerously-bypass-hook-trust', ...spec.args] }
    }
    return spec
  }
  return {
    cmd: process.execPath,
    args: [KEYECHO_CLI, '--mode', 'both'],
    cwd: KEYECHO_PKG,
  }
}

let server = await startServer({ port: PORT, redirectPhoneRootToMobile: false })

// The ordinary harness must never read authenticated provider quota just to paint
// a health chip. Keep it deterministic (and make mixed-pool UI testable) unless
// the explicitly opt-in real-agent lane is running.
if (!REAL_AGENTS) {
  server.registry.modules.rpc.agentQuotaAll = async () => {
    const now = Date.now()
    return [
      {
        machineId: hostMachineId(),
        machineName: 'podium-e2e',
        hostname: 'podium-e2e',
        agents: [
          {
            agent: 'claude-code',
            status: 'ok',
            account: { email: 'claude@example.com', plan: 'max' },
            windows: [
              {
                key: '5h',
                label: '5-hour',
                usedPercent: 3,
                resetsAt: new Date(now + 4.6 * 60 * 60_000).toISOString(),
                windowMinutes: 300,
              },
              {
                key: 'weekly-scoped:model:fable',
                label: 'Fable',
                usedPercent: 98,
                resetsAt: new Date(now + 5 * 24 * 60 * 60_000).toISOString(),
                windowMinutes: 10080,
              },
            ],
            fetchedAt: new Date(now).toISOString(),
          },
          {
            agent: 'codex',
            status: 'ok',
            account: { email: 'codex@example.com', plan: 'plus' },
            windows: [
              {
                key: 'weekly',
                label: 'Weekly',
                usedPercent: 10,
                resetsAt: new Date(now + 6.9 * 24 * 60 * 60_000).toISOString(),
                windowMinutes: 10080,
              },
            ],
            fetchedAt: new Date(now).toISOString(),
          },
        ],
      },
    ]
  }
}

/**
 * PODIUM_E2E_ACCOUNT_ROLE — drive the settings screens as a NON-ADMIN (POD-421).
 *
 * POD-421's acceptance criteria require runtime verification of the settings
 * screens "for both an admin and a non-admin principal". On this build a second
 * human cannot be authenticated at all: `CLIENT_PRINCIPAL_GRADE` is still
 * `device`, so `resolvePrincipal` returns `FIRST_ADMIN_USER_ID` for every
 * transport call and per-user login is POD-315's work.
 *
 * The alternative to a lever here would be to verify only the admin path and
 * assert the member path from unit tests — and an unverified refusing arm is
 * exactly how POD-391's CSWSH guard survived deletion with twenty green tests.
 * So the harness demotes the one account, through the ONE method the gate
 * consults for the account grade, and everything else stays the product: the
 * real router, the real derived procedures, the real gate, the real browser.
 *
 * It is a HARNESS flag and not a product one — nothing in `apps/server` reads
 * it, and it is opt-in and absent by default, so no ordinary run can be
 * silently demoted. Stated plainly so a green member run is not over-read: it
 * shows the SCREENS behave correctly when the server answers as it does for a
 * member. It does not show that a member can log in, because none can yet.
 */
const E2E_ACCOUNT_ROLE = process.env.PODIUM_E2E_ACCOUNT_ROLE
if (E2E_ACCOUNT_ROLE === 'member' || E2E_ACCOUNT_ROLE === 'none') {
  const roleStore = (server.registry as unknown as { store: SessionStore }).store
  const users = roleStore.users as unknown as { roleOf: (id: string) => string | undefined }
  users.roleOf = () => (E2E_ACCOUNT_ROLE === 'member' ? 'member' : undefined)
  console.log(`[e2e] account role forced to ${E2E_ACCOUNT_ROLE}`)
}

if (process.env.PODIUM_E2E_HANDOFF === '1' || process.env.PODIUM_E2E_MULTI_MACHINE === '1') {
  // A second online machine with the same repo identity. It answers discovery only;
  // execution remains covered by the coordinated live two-host E2E.
  const harnessStore = (server.registry as unknown as { store: SessionStore }).store
  harnessStore.machines.upsertMachine({
    id: E2E_TARGET_ID,
    name: 'E2E Target',
    hostname: 'e2e-target',
    tokenHash: 'e2e',
  })
  harnessStore.repos.updateRepoOrigin(hostMachineId(), SCRATCH_REPO, E2E_ORIGIN)
  harnessStore.repos.addRepo(E2E_TARGET_REPO, E2E_TARGET_ID, E2E_ORIGIN)
  server.registry.modules.sessions.attachDaemon(E2E_TARGET_ID, (msg) => {
    if (msg.type === 'scanReposRequest') {
      server.registry.modules.sessions.onDaemonMessageFrom(E2E_TARGET_ID, {
        type: 'scanReposResult',
        requestId: msg.requestId,
        repositories: [
          {
            path: E2E_TARGET_REPO,
            kind: 'repository',
            branch: 'main',
            headSha: execFileSync('git', ['-C', E2E_TARGET_REPO, 'rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim(),
            originUrl: E2E_ORIGIN,
            worktrees: [],
          },
        ],
        diagnostics: [],
      })
    }
  })
  server.registry.modules.machines.recordInventory(E2E_TARGET_ID, {
    os: 'linux',
    arch: 'x64',
    tools: [],
    agents: [
      { kind: 'claude-code', installed: true, login: { state: 'in' } },
      { kind: 'codex', installed: true, login: { state: 'in' } },
    ],
  })
}

const daemonOptions: Parameters<typeof startDaemon>[0] = {
  serverUrl: `ws://localhost:${server.port}`,
  bootstrapToken: server.bootstrapToken,
  machineId: hostMachineId(),
  installCodexHooks: REAL_AGENTS,
  // The fixture is isolated by its per-port state root. TCP callbacks are
  // ephemeral so it never contends with the live instance; Codex continuity is
  // exercised through the stable socket derived from this settings root.
  hooks: { port: 0, settingsDir: join(stateDir, 'hooks') },
  agentRelay: { port: 0 },
  launch,
  ...(realAgentCodexEnv
    ? { discovery: { homeDir: realAgentCodexEnv.discoveryHomeDir } }
    : nativeLoginHome
      ? { discovery: { homeDir: nativeLoginHome } }
      : {}),
  workerClient: inlineWorkerClient(),
}
let daemon = await startDaemon(daemonOptions)
// POD-408: one LIVE, RESUMABLE agent session, so a spec can drive the panel's
// lifecycle arbitration in both directions with real clicks — Hibernate from the
// header overflow (live → parked), Resume from the banner (parked → live).
// `claude-code` rather than `codex`: `createSession` resolves the machine through
// `requireAgent`, which THROWS (and takes the whole harness down) for a harness
// that is not installed on the host, and codex often is not.
if (process.env.PODIUM_E2E_PANEL_LIFECYCLE === '1') {
  const issue = server.registry.modules.issues.create({
    repoPath: REPO_ROOT,
    title: 'Panel lifecycle arbitration',
    startNow: false,
  })
  // The daemon's harness INVENTORY reaches the server asynchronously after
  // `startDaemon` returns, and `createSession` resolves the machine through
  // `requireAgent`, which throws `<kind> is not installed on machine '<host>'`
  // until it lands — taking the whole harness process down with it. That race is
  // why the neighbouring FINISHED_DELEGATE fixture cannot be enabled on a host
  // today (POD-1520). Retry rather than assume.
  let sessionId: string | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < 80 && sessionId === undefined; attempt++) {
    try {
      sessionId = server.registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: REPO_ROOT,
        issueId: issue.id,
        machineId: hostMachineId(),
      }).sessionId
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  if (sessionId === undefined) {
    throw new Error(
      `PODIUM_E2E_PANEL_LIFECYCLE: the agent inventory never arrived — ${String(lastError)}`,
    )
  }
  server.registry.modules.sessions.renameSession({ sessionId, name: 'Lifecycle panel subject' })
  // NO hand-sent `bind` frame. `createSession` already makes the server MINT a
  // SessionBinding and the daemon launch the keyecho jig for a claude-code kind;
  // a synthetic bind on top of that overwrites the minted binding, and the
  // session then cannot be RESURRECTED — `resurrectSession` refuses with "the
  // agent process failed to start: server-minted SessionBinding instruction is
  // required". Which is the whole point of this fixture, so let the real path run.
  //
  // `onSessionDaemonFrame(principal, frame)` — NOT the `onDaemonMessageFrom`
  // (machineId, frame) the neighbouring fixtures still call. POD-389 moved the
  // multiplexer to the gateway and removed that method; a fixture calling it
  // throws at harness boot (POD-1520).
  const principal = inProcessMachinePrincipal(hostMachineId())
  // A resume ref is what makes a session RESUMABLE, which is what makes manual
  // hibernation eligible at all (`sessionMenuEligibility.canHibernate`).
  server.registry.modules.sessions.onSessionDaemonFrame(principal, {
    type: 'sessionResumeRef',
    sessionId,
    resume: { kind: 'claude-session', value: 'e2e-panel-lifecycle' },
  })
  // Idle, not working: hibernating mid-turn is refused (by the panel and by the
  // server), so the fixture must be parkable.
  server.registry.modules.sessions.onSessionDaemonFrame(principal, {
    type: 'agentState',
    sessionId,
    state: {
      phase: 'idle',
      idle: { kind: 'done' },
      since: new Date().toISOString(),
      nativeSubagentCount: 0,
    },
  })
}
// Same-native-id transcript replacement proof (POD-660): one completed issue
// retains a hibernated session whose lake is two device/inode incarnations. The
// browser spec opens the real AgentPanel, which must render both files as one
// transcript and keep the wake action visible.
if (process.env.PODIUM_E2E_TRANSCRIPT_INCARNATION === '1') {
  const issue = server.registry.modules.issues.create({
    repoPath: REPO_ROOT,
    title: 'Completed transcript incarnation',
    startNow: false,
  })
  let sessionId: string | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < 80 && sessionId === undefined; attempt++) {
    try {
      sessionId = server.registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: REPO_ROOT,
        issueId: issue.id,
        machineId: hostMachineId(),
      }).sessionId
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  if (sessionId === undefined) {
    throw new Error(
      `PODIUM_E2E_TRANSCRIPT_INCARNATION: the agent inventory never arrived — ${String(lastError)}`,
    )
  }
  server.registry.modules.sessions.renameSession({
    sessionId,
    name: 'Incarnation chain subject',
  })
  let live = false
  for (let attempt = 0; attempt < 80 && !live; attempt++) {
    live =
      server.registry.modules.sessions
        .listSessions()
        .find((session) => session.sessionId === sessionId)?.status === 'live'
    if (!live) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!live) {
    throw new Error('PODIUM_E2E_TRANSCRIPT_INCARNATION: session never became live')
  }
  const nativeId = 'e2e-reused-native-id'
  const principal = inProcessMachinePrincipal(hostMachineId())
  server.registry.modules.sessions.onSessionDaemonFrame(principal, {
    type: 'sessionResumeRef',
    sessionId,
    resume: { kind: 'claude-session', value: nativeId },
  })
  server.registry.modules.sessions.onSessionDaemonFrame(principal, {
    type: 'agentState',
    sessionId,
    state: {
      phase: 'idle',
      idle: { kind: 'done' },
      since: new Date().toISOString(),
      nativeSubagentCount: 0,
    },
  })

  const predecessor = `${JSON.stringify({
    type: 'user',
    uuid: 'e2e-incarnation-user',
    timestamp: '2026-08-08T21:06:39.000Z',
    message: { role: 'user', content: 'Earlier transcript incarnation is still readable.' },
  })}\n`
  const current = `${JSON.stringify({
    type: 'assistant',
    uuid: 'e2e-incarnation-assistant',
    timestamp: '2026-08-08T21:57:00.000Z',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Replacement inode continues the same session.' }],
    },
  })}\n`
  const machineId = hostMachineId()
  const lakeDir = join(stateDir, 'transcripts', machineId)
  mkdirSync(lakeDir, { recursive: true })
  writeFileSync(join(lakeDir, `${nativeId}.incarnation-1.jsonl`), predecessor)
  writeFileSync(join(lakeDir, `${nativeId}.jsonl`), current)
  const harnessStore = (server.registry as unknown as { store: SessionStore }).store
  harnessStore.conversations.mirror.startIncarnation(
    machineId,
    nativeId,
    { device: '7', inode: '8961297' },
    '2026-08-08T21:06:39Z',
  )
  harnessStore.conversations.mirror.rotateIncarnation(
    machineId,
    nativeId,
    { device: '7', inode: '7115245' },
    Buffer.byteLength(predecessor),
    '2026-08-08T21:57:00Z',
  )
  harnessStore.conversations.mirror.setMirrorCursor(
    machineId,
    nativeId,
    Buffer.byteLength(current),
    '2026-08-08T21:57:01Z',
  )
  const hibernated = server.registry.modules.sessions.hibernateSession({ sessionId })
  if (!hibernated.ok) {
    throw new Error(
      `PODIUM_E2E_TRANSCRIPT_INCARNATION: hibernate refused — ${hibernated.reason ?? 'unknown'}`,
    )
  }
  server.registry.modules.issues.close(issue.id, 'done')
}
if (process.env.PODIUM_E2E_FINISHED_DELEGATE === '1') {
  const issue = server.registry.modules.issues.create({
    repoPath: REPO_ROOT,
    title: 'Finished delegate decay',
    startNow: false,
  })
  const { sessionId } = server.registry.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: REPO_ROOT,
    issueId: issue.id,
    machineId: hostMachineId(),
  })
  server.registry.modules.sessions.renameSession({ sessionId, name: 'Finished relay delegate A' })
  server.registry.modules.sessions.onDaemonMessageFrom(hostMachineId(), {
    type: 'bind',
    sessionId,
    cmd: 'codex',
    cwd: REPO_ROOT,
    agentKind: 'codex',
    geometry: { cols: 80, rows: 24 },
  })
  server.registry.modules.sessions.onDaemonMessageFrom(hostMachineId(), {
    type: 'sessionResumeRef',
    sessionId,
    resume: { kind: 'codex-thread', value: 'e2e-finished-delegate' },
  })
  server.registry.modules.sessions.onDaemonMessageFrom(hostMachineId(), {
    type: 'agentState',
    sessionId,
    state: {
      phase: 'idle',
      idle: { kind: 'done' },
      since: new Date().toISOString(),
      nativeSubagentCount: 0,
    },
  })
  server.registry.modules.sessions.hibernateSession({ sessionId })
  const { sessionId: secondId } = server.registry.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: REPO_ROOT,
    issueId: issue.id,
    machineId: hostMachineId(),
  })
  server.registry.modules.sessions.renameSession({
    sessionId: secondId,
    name: 'Finished relay delegate B',
  })
  server.registry.modules.sessions.onDaemonMessageFrom(hostMachineId(), {
    type: 'bind',
    sessionId: secondId,
    cmd: 'codex',
    cwd: REPO_ROOT,
    agentKind: 'codex',
    geometry: { cols: 80, rows: 24 },
  })
  server.registry.modules.sessions.onDaemonMessageFrom(hostMachineId(), {
    type: 'sessionResumeRef',
    sessionId: secondId,
    resume: { kind: 'codex-thread', value: 'e2e-finished-delegate-2' },
  })
  server.registry.modules.sessions.onDaemonMessageFrom(hostMachineId(), {
    type: 'agentState',
    sessionId: secondId,
    state: {
      phase: 'idle',
      idle: { kind: 'done' },
      since: new Date().toISOString(),
      nativeSubagentCount: 0,
    },
  })
  server.registry.modules.sessions.hibernateSession({ sessionId: secondId })
  server.registry.modules.issues.close(issue.id, 'done')
}
if (process.env.PODIUM_E2E_OFFER === '1') {
  const issue = server.registry.modules.issues.create({
    repoPath: REPO_ROOT,
    title: 'Native offer layout',
    startNow: false,
  })
  const { sessionId } = server.registry.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: REPO_ROOT,
    issueId: issue.id,
    machineId: hostMachineId(),
  })
  setTimeout(() => {
    // Match the real review-offer lifecycle: the turn has completed, while the
    // offer it produced still needs a human decision.
    server.registry.modules.sessions.onDaemonMessageFrom(hostMachineId(), {
      type: 'agentState',
      sessionId,
      state: {
        phase: 'idle',
        idle: { kind: 'done' },
        since: new Date().toISOString(),
        nativeSubagentCount: 0,
      },
    })
    server.registry.modules.sessions.setOffer({
      sessionId,
      message: 'Native offer layout check',
      actions: [
        { label: 'Keep it', prompt: 'Keep the verified layout' },
        {
          label: 'Request changes',
          prompt: 'Revise the layout per this feedback:',
          input: true,
        },
      ],
    })
  }, 2_000)
}
if (process.env.PODIUM_E2E_HANDOFF === '1') {
  server.registry.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd: SCRATCH_FEAT,
    machineId: hostMachineId(),
  })
}
// TWO SESSIONS UNDER ONE ISSUE WHOSE ATTRIBUTION PAIRS DIFFER IN SHAPE (POD-1526).
//
// The DELEGATED one is the whole point of the fixture. Both sessions here are
// created through the real `createSession`, so the server stamps `createdBy`
// itself from the binding principal (ADR 3 D7) rather than the fixture asserting
// a pair — a hand-set field would make the browser spec a test of this file.
//
// The parent takes the default USER principal, which stamps the same human into
// both halves. That case CANNOT prove the pair survives: a renderer that printed
// the actor twice would satisfy it. So the child is bound to an AGENT principal
// whose `parentBindingId` is the parent session, which stamps actor=<agent> and
// onBehalfOf=<the delegating human> — two DIFFERENT values, which is the only
// arrangement in which a collapsed renderer is visibly wrong.
if (process.env.PODIUM_E2E_SESSION_ATTRIBUTION === '1') {
  const issue = server.registry.modules.issues.create({
    repoPath: REPO_ROOT,
    title: 'Session attribution rows',
    startNow: false,
  })
  // The daemon's harness INVENTORY reaches the server asynchronously after
  // `startDaemon` returns, so `createSession` throws `<kind> is not installed`
  // until it lands and takes the whole harness down with it — the same race the
  // PANEL_LIFECYCLE fixture above documents. Retry rather than assume.
  let parentId: string | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < 80 && parentId === undefined; attempt++) {
    try {
      parentId = server.registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: REPO_ROOT,
        issueId: issue.id,
        machineId: hostMachineId(),
      }).sessionId
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  if (parentId === undefined) {
    throw new Error(
      `PODIUM_E2E_SESSION_ATTRIBUTION: the agent inventory never arrived — ${String(lastError)}`,
    )
  }
  server.registry.modules.sessions.renameSession({ sessionId: parentId, name: 'Attribution host' })
  // WAIT FOR THE PARENT'S BINDING, WHICH IS NOT A RETRY (POD-1526).
  //
  // `createSession` for an AGENT principal SUCCEEDS synchronously and then fails
  // asynchronously — the daemon rejects the spawn transition with
  // `parent-binding-missing` and the child lands `exited`. So retrying the CALL
  // catches nothing: it never throws. The only honest fix is to wait for the
  // thing the child depends on, which is the parent's binding, minted when the
  // parent's own spawn transition completes. `agentState` is the observable
  // consequence of exactly that, so it is the signal polled here.
  //
  // Getting this wrong is what made the browser spec flaky rather than failing:
  // when the parent bound quickly the child spawned and two rows appeared, and
  // when it did not the child died on arrival — the same fixture reporting two
  // different worlds.
  // RETRY ON THE OUTCOME, BECAUSE THE FAILURE IS ASYNCHRONOUS. `createSession`
  // for an AGENT principal succeeds synchronously and only then does the daemon
  // reject the spawn transition with `parent-binding-missing`, landing the child
  // `exited`. So retrying the CALL catches nothing — it never throws — and the
  // parent's own `agentState` is not the signal either: the keyecho jig may
  // never report one, which turned a wait on it into a hard fixture failure.
  // What IS observable is whether the child survived, so that is what is waited
  // on and retried. Casualties are archived rather than left on screen: a dead
  // row from a lost race is not a fixture the spec should have to reason about.
  const statusOf = (id: string): string | undefined =>
    server.registry.modules.sessions.listSessions().find((s) => s.sessionId === id)?.status
  let childId: string | undefined
  for (let attempt = 0; attempt < 30 && childId === undefined; attempt++) {
    const candidate = server.registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: REPO_ROOT,
      issueId: issue.id,
      machineId: hostMachineId(),
      binding: { principal: { kind: 'agent', parentBindingId: parentId } },
    }).sessionId
    // Give the daemon a moment to accept or reject the transition.
    for (let settle = 0; settle < 12 && statusOf(candidate) !== 'exited'; settle++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (statusOf(candidate) === 'exited') {
      server.registry.modules.sessions.setArchived({ sessionId: candidate, archived: true })
      continue
    }
    childId = candidate
  }
  if (childId === undefined) {
    throw new Error(
      'PODIUM_E2E_SESSION_ATTRIBUTION: no delegated child survived its spawn, so there is no delegated pair to render',
    )
  }
  server.registry.modules.sessions.renameSession({ sessionId: childId, name: 'Delegated worker' })
}
console.log(
  `harness relay on ws://localhost:${server.port} (shell=real, else=keyecho); state=${stateDir}`,
)
// Test-only process control: a Playwright spec can restart ONLY the relay while
// leaving the daemon + durable PTY host alive, matching a production server restart.
// The serial file is the completion ack; the deliberate offline window gives the
// browser time to prove its xterm canvas stays untouched while disconnected.
const restartSerialFile = join(stateDir, 'restart-serial')
const daemonRestartSerialFile = join(stateDir, 'daemon-restart-serial')
const pidFile = harnessPidFile(PORT)
let restartSerial = 0
let restartInFlight = false
let daemonRestartSerial = 0
let daemonRestartInFlight = false
let shuttingDown = false
writeFileSync(pidFile, String(process.pid))
writeFileSync(restartSerialFile, String(restartSerial))
writeFileSync(daemonRestartSerialFile, String(daemonRestartSerial))
const restartServer = async (): Promise<void> => {
  if (restartInFlight || shuttingDown) return
  restartInFlight = true
  try {
    await server.close()
    await new Promise((resolve) => setTimeout(resolve, 750))
    if (shuttingDown) return
    server = await startServer({ port: PORT, redirectPhoneRootToMobile: false })
    restartSerial += 1
    writeFileSync(restartSerialFile, String(restartSerial))
  } finally {
    restartInFlight = false
  }
}
process.on('SIGUSR1', () => void restartServer())

const restartDaemon = async (): Promise<void> => {
  if (daemonRestartInFlight || shuttingDown) return
  daemonRestartInFlight = true
  try {
    // Detach only. Durable abduco/tmux masters (and their inherited stable hook
    // socket path) survive; the replacement daemon reuses that path and reattaches.
    await daemon.close()
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (shuttingDown) return
    daemon = await startDaemon(daemonOptions)
    daemonRestartSerial += 1
    writeFileSync(daemonRestartSerialFile, String(daemonRestartSerial))
  } finally {
    daemonRestartInFlight = false
  }
}
process.on('SIGUSR2', () => void restartDaemon())

let shutdownPromise: Promise<void> | undefined
const shutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise
  shuttingDown = true
  shutdownPromise = (async () => {
    // Full reap: harness sessions are throwaway — without this every e2e run leaks
    // durable abduco/tmux masters (durability is the feature; the harness opts out).
    await daemon.close({ reapSessions: true })
    await server.close()
    // globalTeardown treats removal as the acknowledgement that every writer above
    // is closed. On failure the marker stays until shutdownAndExit kills this process.
    rmSync(pidFile, { force: true })
  })()
  return shutdownPromise
}
const shutdownAndExit = (): void => {
  void shutdown().then(
    () => process.exit(0),
    (err) => {
      console.error('[podium:e2e] harness shutdown failed:', err)
      process.exit(1)
    },
  )
}
process.on('SIGINT', shutdownAndExit)
process.on('SIGTERM', shutdownAndExit)
await new Promise(() => {})
