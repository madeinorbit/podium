/**
 * THE POISONED MACHINE (POD-6536, design docs/design/harness-access-contract.md
 * §3.6 "Poisoned-machine conformance test").
 *
 * One machine per harness (the six shipped adapters plus the fixture) on which
 * every ambient answer is a decoy:
 *
 *  - a fake `<harness>` binary at the FRONT of PATH that records it ran and
 *    exits 1 — in the machine command environment AND in `process.env`;
 *  - a decoy HOME and decoy harness selectors (`CODEX_HOME`,
 *    `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `PI_CODING_AGENT_DIR`, `XDG_*`) whose
 *    folders hold sentinel files — in `process.env` always, and in the machine
 *    command environment wherever the contract already overrides that
 *    selector for an account (see MACHINE_SELECTOR_GAPS);
 *  - the selected installation is a RECORDING fake binary somewhere else,
 *    and the account home is somewhere else again.
 *
 * Every supported section of the manifest that needs no model then runs
 * against the harness context for that account, and three things must hold:
 *
 *  1. No decoy file or folder was READ (its access time did not move: the
 *     sentinels are dated before their mtime, which relatime always updates)
 *     or MODIFIED (its bytes and listing are unchanged).
 *  2. The decoy binary never ran.
 *  3. Every child the sections started recorded the selected installation as
 *     its argv[0].
 *
 * The cases are keyed by `sectionStatusesOf(manifest)`: a supported section
 * with no case here FAILS, so a newly declared section cannot slip past.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { asAccountId, asSessionId, type BuiltinHarnessKind } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtureManifest } from './adapters/fixture/index.js'
import { type BoundCommand, harnessCommand } from './bound-command.js'
import {
  allocationInvocation,
  composeHeadlessInvocation,
  needsAllocation,
} from './driver/families/headless/invocation.js'
import type { HeadlessTurnSpec } from './driver/families/headless/types.js'
import { harnessChildEnv, harnessContext, harnessDriverContext } from './harness-context.js'
import type { HarnessContext } from './harness-context-types.js'
import { installTargetFor, runInstallTarget } from './inventory/install.js'
import { agentLaunchCommand } from './launch.js'
import {
  type AgentManifest,
  credentialFileReader,
  declaredValue,
  type HarnessObserverHost,
  resolveCredentialFilePath,
} from './manifest.js'
import { AGENT_MANIFESTS, registerTestManifest, sectionStatusesOf } from './registry.js'
import { transcriptSourceFromGrammar } from './store/store.js'

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

const KINDS = [...(Object.keys(AGENT_MANIFESTS) as BuiltinHarnessKind[]), 'fixture'] as const
type Kind = (typeof KINDS)[number]

const manifestOf = (kind: Kind): AgentManifest =>
  kind === 'fixture' ? fixtureManifest : AGENT_MANIFESTS[kind as BuiltinHarnessKind]

/** Every selector a harness reads its folders from. */
const SELECTORS = [
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GROK_HOME',
  'PI_CODING_AGENT_DIR',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
] as const

/**
 * Selectors the contract does NOT yet override for an account when the
 * operator's own command environment sets them: an ambient `CLAUDE_CONFIG_DIR`
 * still redirects Claude, and `XDG_*` still redirects OpenCode, in the child
 * and in every account read alike. That decision is POD-6604 (Ambient Claude
 * and XDG selectors). Until it lands these decoys sit in `process.env` only;
 * every other harness gets them in the machine env too.
 */
const MACHINE_SELECTOR_GAPS: Partial<Record<Kind, readonly string[]>> = {
  'claude-code': ['CLAUDE_CONFIG_DIR'],
  opencode: ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'],
}

/** Every executable name a harness (or its server alternative) is run by. */
const HARNESS_BINARIES = [
  ...new Set(
    KINDS.flatMap((kind) => [
      ...manifestOf(kind).inventory.executable.names,
      ...(manifestOf(kind).runtime.serverAlternatives ?? []).flatMap((alt) =>
        alt.executable ? [alt.executable] : [],
      ),
    ]),
  ),
]

/** Harness folders under a home that a decoy home fills with sentinels. */
const HOME_FOLDERS = [
  '.codex',
  '.claude',
  '.grok',
  join('.pi', 'agent'),
  join('.local', 'share', 'opencode'),
  join('.local', 'share', 'podium'),
  join('.config', 'opencode'),
  join('.local', 'state', 'opencode'),
  '.cursor',
  '.fixture',
]

const CWD = '/work/poisoned-repo'
const RESUME = '019a0000-0000-7000-8000-000000000001'
const SECRET = 'DECOY-SENTINEL'

interface World {
  root: string
  decoyBin: string
  decoyRan: string
  decoyHome: string
  decoySelectors: Record<(typeof SELECTORS)[number], string>
  records: string
  installRoot: string
  accountHome: string
  /** Every decoy file and folder, with what it must still be at the end. */
  sentinels: Map<string, { atimeMs: number; digest: string }>
}

function sentinelTree(dir: string): void {
  mkdirSync(dir, { recursive: true })
  // A file a harness would read here, and a nested folder a scan would walk.
  for (const name of ['auth.json', '.credentials.json', 'config.toml', 'opencode.db']) {
    writeFileSync(join(dir, name), JSON.stringify({ [SECRET]: dir, email: 'decoy@poison' }))
  }
  mkdirSync(join(dir, 'sessions', 'nested'), { recursive: true })
  writeFileSync(join(dir, 'sessions', 'nested', `${RESUME}.jsonl`), `{"${SECRET}":true}\n`)
  mkdirSync(join(dir, 'projects', 'nested'), { recursive: true })
  writeFileSync(join(dir, 'projects', 'nested', `${RESUME}.jsonl`), `{"${SECRET}":true}\n`)
}

function digestOf(path: string): string {
  const stat = statSync(path)
  if (stat.isDirectory()) return `dir:${readdirSync(path).sort().join('\0')}`
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function walk(path: string, into: string[]): void {
  into.push(path)
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry), into)
  }
}

/** Date every sentinel's access time three days BEFORE its mtime: relatime
 *  then moves it on the next read or listing, so a read cannot hide. */
function armSentinels(world: World, roots: readonly string[]): void {
  const paths: string[] = []
  for (const root of roots) walk(root, paths)
  const now = Date.now() / 1000
  // Digest first (it reads), then date the access times.
  const digests = new Map(paths.map((path) => [path, digestOf(path)]))
  world.sentinels.clear()
  for (const path of paths.reverse()) {
    utimesSync(path, now - 3 * 86_400, now)
  }
  for (const path of paths) {
    world.sentinels.set(path, { atimeMs: statSync(path).atimeMs, digest: digests.get(path) ?? '' })
  }
}

function touchedSentinels(world: World): string[] {
  const touched: string[] = []
  for (const [path, before] of world.sentinels) {
    if (!existsSync(path)) {
      touched.push(`${path} (deleted)`)
      continue
    }
    const atimeMs = statSync(path).atimeMs
    if (atimeMs !== before.atimeMs) touched.push(`${path} (read)`)
    else if (digestOf(path) !== before.digest) touched.push(`${path} (modified)`)
    // Re-reading the digest moved the access time; put it back.
    if (atimeMs === before.atimeMs)
      utimesSync(path, before.atimeMs / 1000, statSync(path).mtimeMs / 1000)
  }
  return touched
}

function buildWorld(): World {
  const root = mkdtempSync(join(tmpdir(), 'podium-poisoned-'))
  const decoyBin = join(root, 'decoy-bin')
  const decoyRan = join(root, 'decoy-ran')
  mkdirSync(decoyBin)
  for (const name of HARNESS_BINARIES) {
    const path = join(decoyBin, name)
    writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> '${decoyRan}'\nexit 1\n`)
    chmodSync(path, 0o755)
  }
  const decoyHome = join(root, 'decoy-home')
  for (const folder of HOME_FOLDERS) sentinelTree(join(decoyHome, folder))
  writeFileSync(join(decoyHome, '.claude.json'), JSON.stringify({ [SECRET]: true }))
  const decoySelectors = Object.fromEntries(
    SELECTORS.map((name) => {
      const dir = join(root, `decoy-${name.toLowerCase()}`)
      sentinelTree(dir)
      for (const folder of ['opencode', 'podium']) sentinelTree(join(dir, folder))
      return [name, dir]
    }),
  ) as World['decoySelectors']
  const records = join(root, 'records')
  mkdirSync(records)
  const installRoot = join(root, 'selected-install')
  mkdirSync(installRoot)
  const accountHome = join(root, 'account-home')
  mkdirSync(accountHome)
  return {
    root,
    decoyBin,
    decoyRan,
    decoyHome,
    decoySelectors,
    records,
    installRoot,
    accountHome,
    sentinels: new Map(),
  }
}

/** The selected installation: records its argv[0] and arguments, then exits
 *  0 printing a version, whatever it is asked. */
function recordingBinary(world: World, kind: Kind, name: string): string {
  const dir = join(world.installRoot, kind)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `f='${world.records}/'"$$"'-'"$(date +%s%N)"`,
      `printf 'ARGV0=%s\\n' "$0" > "$f"`,
      'for a in "$@"; do printf "ARG=%s\\n" "$a" >> "$f"; done',
      'echo "codex-cli 0.162.0"',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(path, 0o755)
  return path
}

function recordedArgv0(world: World): string[] {
  return readdirSync(world.records).map(
    (file) =>
      readFileSync(join(world.records, file), 'utf8')
        .split('\n')[0]
        ?.replace(/^ARGV0=/, '') ?? '',
  )
}

// ---------------------------------------------------------------------------
// One harness on the machine
// ---------------------------------------------------------------------------

interface Harness {
  kind: Kind
  manifest: AgentManifest
  world: World
  context: HarnessContext
  /** Run a bound command to completion as its spawn site would. */
  spawn(command: BoundCommand, opts?: { stdin?: string; env?: Record<string, string> }): void
  /** Children this case started (argv[0] must be the selected path). */
  spawned: number
}

function harnessOn(world: World, kind: Kind): Harness {
  const manifest = manifestOf(kind)
  const selected = recordingBinary(world, kind, manifest.inventory.executable.names[0] ?? kind)
  const machineEnv: Record<string, string> = {
    PATH: [world.decoyBin, '/usr/bin', '/bin'].join(delimiter),
    HOME: world.decoyHome,
    ...Object.fromEntries(
      SELECTORS.filter((name) => !MACHINE_SELECTOR_GAPS[kind]?.includes(name)).map((name) => [
        name,
        world.decoySelectors[name],
      ]),
    ),
  }
  const snapshot = {
    executables: new Map([
      [kind, { kind, path: selected, version: 'codex-cli 0.162.0', generation: 1 }],
    ]),
    commandEnvironment: {
      env: machineEnv,
      pathEntries: machineEnv.PATH?.split(delimiter) ?? [],
      source: 'login-shell',
      generation: 1,
      machineHome: world.decoyHome,
      loginShell: '/bin/sh',
      // The inventory's own lookup is not under test: the snapshot is what it
      // verified. A second binary (opencode2) is the selected one's sibling.
      resolve: (command: string) => recordingBinary(world, kind, command),
    },
  } as never
  const context = harnessContext(snapshot, kind as BuiltinHarnessKind, world.accountHome)
  const harness: Harness = {
    kind,
    manifest,
    world,
    context,
    spawned: 0,
    spawn(command, opts = {}) {
      const own = (command as BoundCommand & { env?: Record<string, string> }).env
      const { env } = harnessChildEnv(context, { wiringEnv: { ...own, ...opts.env } })
      try {
        execFileSync(command.cmd, command.args, {
          env,
          input: opts.stdin ?? '',
          stdio: ['pipe', 'ignore', 'ignore'],
          timeout: 10_000,
        })
      } catch {
        // The recording binary exits 0; a failure is a wrong argv[0], which
        // the argv[0] assertion reports with the path.
      }
      harness.spawned += 1
    },
  }
  ;(harness as Harness & { snapshot: unknown }).snapshot = snapshot
  return harness
}

const snapshotOf = (h: Harness) => (h as Harness & { snapshot: never }).snapshot

function recordingHost(): HarnessObserverHost & { tailed: string[] } {
  const tailed: string[] = []
  return {
    tailed,
    tailFile: (path) => void tailed.push(path),
    onResumeValue: () => {},
    onTitle: () => {},
    onStateEvents: () => {},
    onObservation: () => {},
    onExactProviderRebind: () => {},
    onTranscriptItems: () => {},
  } as HarnessObserverHost & { tailed: string[] }
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// The cases: one per section path. A supported section without one fails.
// ---------------------------------------------------------------------------

type Case = (h: Harness) => Promise<void> | void

/** Sections that run no model and touch no machine: a function over data. */
const PURE = (why: string): Case => {
  const run: Case = () => {
    expect(why.length).toBeGreaterThan(0)
  }
  return run
}

/** Sections that cannot run without a live model, with the reason. */
const NEEDS_MODEL = new Map<string, string>([
  [
    'runtime.embedded',
    'the Claude SDK hosts the model call in-process; its spawn goes through the claude-sdk engine host (runtime.server-shaped, covered by headless)',
  ],
])

const CASES: Record<string, Case> = {
  // --- not Declared, but every harness has them ----------------------------
  launch: (h) => {
    const runtimeDir = join(h.world.root, `runtime-${h.kind}`)
    mkdirSync(runtimeDir, { recursive: true })
    const command = agentLaunchCommand(h.kind as BuiltinHarnessKind, {
      cwd: CWD,
      harnessContext: h.context,
      runtimeDir,
      podiumSessionId: asSessionId(`poisoned-${h.kind}`),
      instructions: [{ source: 'issue', content: 'conformance' }],
    })
    if (!('cmd' in command)) throw new Error('launch produced no command')
    h.spawn(command as BoundCommand)
  },
  roots: (h) => {
    for (const root of Object.values(h.context.roots)) {
      if (root) expect(root.startsWith(h.world.accountHome), `${h.kind} root ${root}`).toBe(true)
    }
  },
  discovery: async (h) => {
    for (const root of h.manifest.discovery.defaultRoots({ homeDir: h.context.home })) {
      expect(root.startsWith(h.world.accountHome), `${h.kind} discovery root ${root}`).toBe(true)
      await h.manifest.discovery.listRoot(root).catch(() => undefined)
    }
  },
  'inventory.detectLogin': (h) => {
    const login = h.manifest.inventory.detectLogin(h.context.home, h.context.env)
    expect(JSON.stringify(login)).not.toContain('decoy')
  },

  // --- top-level Declared sections ------------------------------------------
  credentials: (h) => {
    const section = declaredValue(h.manifest.credentials)
    if (!section) return
    const identity = section.identity(credentialFileReader(section, h.context.home, h.context.env))
    expect(JSON.stringify(identity ?? null)).not.toContain('decoy')
  },
  'credentials.transfer': async (h) => {
    const section = declaredValue(h.manifest.credentials)
    const transfer = section && declaredValue(section.transfer)
    if (!section || !transfer) return
    for (const file of section.files) {
      const store = transfer.createStore({
        platform: 'linux',
        home: h.context.home,
        env: h.context.env,
        versions: new Map(),
        file,
        fileAbsolutePath: resolveCredentialFilePath(file, h.context.home, { env: h.context.env }),
      })
      const read = await store?.read()
      expect(JSON.stringify(read ?? null)).not.toContain(SECRET)
    }
  },
  usage: () => {
    // A container: quota, history and transcripts each run below.
  },
  'usage.quota': async (h) => {
    const quota = declaredValue(declaredValue(h.manifest.usage)!.quota)!
    const seen: string[] = []
    const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(`${String(url)} ${JSON.stringify(init?.headers ?? {})}`)
      return new Response('{}', { status: 401 })
    }) as unknown as typeof fetch
    await quota.fetchQuota({ account: h.context, fetchImpl }).catch(() => undefined)
    expect(seen.join('\n')).not.toContain('decoy')
  },
  'usage.history': async (h) => {
    const history = declaredValue(declaredValue(h.manifest.usage)!.history)!
    await history.scan({ sinceMs: 0, machineId: 'poisoned', account: h.context })
  },
  'usage.transcripts': async (h) => {
    const transcripts = declaredValue(declaredValue(h.manifest.usage)!.transcripts)!
    const scans = await transcripts.scan({ sinceMs: 0, account: h.context })
    for (const scan of scans) expect(scan.path.startsWith(h.world.accountHome)).toBe(true)
  },
  install: (h) => {
    const bin = join(h.world.root, `install-bin-${h.kind}`)
    mkdirSync(bin, { recursive: true })
    const ran: string[] = []
    runInstallTarget(installTargetFor(h.kind), bin, {
      fetch: (_url, out) => writeFileSync(out, '#!/bin/sh\n'),
      run: (cmd) => {
        ran.push(cmd)
        return ''
      },
      runTool: (tool) => {
        ran.push(`tool:${tool}`)
        return ''
      },
      env: h.context.env as NodeJS.ProcessEnv,
      arch: 'x64',
      isMusl: () => false,
    })
    // The verify runs the produced binary by absolute path; every installer
    // shell goes through the OS-tool port. Nothing is run by bare name.
    for (const cmd of ran) expect(cmd.startsWith('/') || cmd.startsWith('tool:'), cmd).toBe(true)
  },
  exec: (h) => {
    const exec = declaredValue(h.manifest.exec)!
    const argv = exec({ prompt: 'conformance', systemPrompt: 'system' })
    const { stdin, ...command } = harnessCommand(h.context, argv)
    h.spawn(command, { ...(stdin !== undefined ? { stdin } : {}) })
  },
  headless: (h) => {
    if (h.kind === 'fixture') return // the fixture's headless runs through buildExec below
    const spec: HeadlessTurnSpec = {
      agent: h.kind as BuiltinHarnessKind,
      accountId: asAccountId(`native:${h.kind}:poisoned`),
      requestDigest: 'a'.repeat(64),
      cwd: CWD,
      prompt: 'conformance',
      sessionUuid: RESUME,
    }
    // Cursor allocates its chat first (`create-chat`), then runs pinned to it.
    const allocated = needsAllocation(spec) ? RESUME : undefined
    if (allocated) h.spawn(allocationInvocation(spec, snapshotOf(h)).command)
    const invocation = composeHeadlessInvocation(spec, snapshotOf(h), {
      isRoot: false,
      ...(allocated ? { allocated } : {}),
    })
    h.spawn(invocation.command, {
      ...(invocation.stdin.kind === 'bytes' ? { stdin: invocation.stdin.data } : {}),
      ...(invocation.execEnv ? { env: invocation.execEnv } : {}),
    })
  },
  'headless.buildExec': (h) => {
    const buildExec = declaredValue(declaredValue(h.manifest.headless)!.buildExec)!
    const { stdin, ...command } = harnessCommand(
      h.context,
      buildExec({ prompt: 'conformance', sessionId: RESUME, resumeValue: RESUME }),
    )
    h.spawn(command, { ...(stdin !== undefined ? { stdin } : {}) })
  },
  state: async (h) => {
    const provider = declaredValue(h.manifest.state)!
    const events = await provider.bootEvents?.({
      cwd: CWD,
      resumeValue: RESUME,
      podiumSessionId: asSessionId(`poisoned-${h.kind}`),
      account: h.context,
    })
    expect(JSON.stringify(events ?? [])).not.toContain(SECRET)
    // A Stop hook that names its session by id only (Grok derives the path).
    await provider.translate(
      { hook_event_name: 'Stop', hookEventName: 'Stop', sessionId: RESUME, cwd: CWD },
      h.context,
    )
  },
  instrumentation: async (h) => {
    const instrumentation = declaredValue(h.manifest.instrumentation)!
    const settingsDir = join(h.world.root, `settings-${h.kind}`)
    mkdirSync(settingsDir, { recursive: true })
    const installed = await instrumentation.install({
      sessionId: asSessionId(`poisoned-${h.kind}`),
      endpointUrl: 'http://127.0.0.1:9/hooks',
      settingsDir,
      harnessContext: h.context,
    })
    if (installed.file) {
      expect(
        installed.file.path.startsWith(settingsDir) ||
          installed.file.path.startsWith(h.world.accountHome),
        installed.file.path,
      ).toBe(true)
    }
  },
  observer: async (h) => {
    const observe = declaredValue(h.manifest.observer)!
    const host = recordingHost()
    const observation = observe(
      {
        cwd: CWD,
        resumeValue: RESUME,
        podiumSessionId: asSessionId(`poisoned-${h.kind}`),
        account: h.context,
        harnessContext: h.context,
        loadOpencodeSource: async () => ({ stampOpencodeItems: () => [] }),
      },
      host,
    )
    await settle(250)
    observation.stop()
    for (const path of host.tailed) {
      expect(path.startsWith(h.world.accountHome), `${h.kind} tailed ${path}`).toBe(true)
    }
  },
  transcript: async (h) => {
    const grammar = declaredValue(h.manifest.transcript)!
    const source = await transcriptSourceFromGrammar(grammar, {
      cwd: CWD,
      resumeValue: RESUME,
      podiumSessionId: asSessionId(`poisoned-${h.kind}`),
      account: h.context,
    })
    const slice = await source.readSlice({ direction: 'before', limit: 10 })
    expect(JSON.stringify(slice)).not.toContain(SECRET)
  },
  'transcript.chainPaths': async (h) => {
    const chainPaths = declaredValue(declaredValue(h.manifest.transcript)!.chainPaths)!
    const paths = await chainPaths({ cwd: CWD, resumeValue: RESUME, account: h.context })
    for (const path of paths) expect(path.startsWith(h.world.accountHome), path).toBe(true)
  },
  'transcript.sqliteLocator': (h) => {
    const locate = declaredValue(declaredValue(h.manifest.transcript)!.sqliteLocator)!
    const locator = locate({
      cwd: CWD,
      resumeValue: RESUME,
      podiumSessionId: asSessionId(`poisoned-${h.kind}`),
      account: h.context,
    })
    expect(locator?.homeDir).toBe(h.world.accountHome)
    if (locator?.databasePath)
      expect(locator.databasePath.startsWith(h.world.accountHome)).toBe(true)
  },
  'transcript.recordToItems': PURE('maps one parsed record to items'),
  'transcript.recordRuntime': PURE('reads model/effort off one parsed record'),
  'transcript.recordColor': PURE('reads a color off one parsed record'),
  composer: PURE('pure scrape/inject/verify rules over screen text'),
  classifyBrowserOpen: (h) => {
    declaredValue(h.manifest.classifyBrowserOpen)!(new URL('https://example.invalid/login'))
  },
  handoffTranscript: async (h) => {
    const handoff = declaredValue(h.manifest.handoffTranscript)!
    const placement = handoff.transcriptPlacement({
      cwd: CWD,
      homeDir: h.context.home,
      resumeValue: RESUME,
      filename: `${RESUME}.jsonl`,
    })
    expect(placement.startsWith(h.world.accountHome), placement).toBe(true)
    await handoff
      .transcriptForExport({ cwd: CWD, homeDir: h.context.home, resumeValue: RESUME })
      .catch(() => undefined)
  },

  // --- inventory --------------------------------------------------------------
  'inventory.loginCommand': (h) => {
    const login = declaredValue(h.manifest.inventory.loginCommand)!
    h.spawn(harnessCommand(h.context, { args: [...login.args] }))
  },
  'inventory.loginCommandProbe': (h) => {
    const probe = declaredValue(h.manifest.inventory.loginCommandProbe)!
    h.spawn(harnessCommand(h.context, { args: [...probe.args] }))
  },
  'inventory.loginIdentity': (h) => {
    const identity = declaredValue(h.manifest.inventory.loginIdentity)!(
      h.context.home,
      h.context.env,
    )
    expect(JSON.stringify(identity ?? null)).not.toContain('decoy')
  },
  'inventory.portableCredential': (h) => {
    const portable = declaredValue(h.manifest.inventory.portableCredential)!
    expect(portable.files.length).toBeGreaterThan(0)
  },

  // --- runtime ----------------------------------------------------------------
  'runtime.server': (h) => {
    const server = declaredValue(h.manifest.runtime.server)!
    const context = harnessDriverContext(
      snapshotOf(h),
      h.kind as BuiltinHarnessKind,
      h.context.home,
      server.driverId,
    )
    const args = server.spawn.slice(1).map((arg) => (arg === '<daemon-picked>' ? '0' : arg))
    h.spawn(harnessCommand(context, { args }))
  },
  'runtime.server.versionRange': PURE('a semver range string'),
  'runtime.server.clientTerminal': (h) => {
    const client = declaredValue(declaredValue(h.manifest.runtime.server)!.clientTerminal)!
    h.spawn(
      harnessCommand(
        h.context,
        client.launch({
          cwd: CWD,
          conversation: RESUME,
          endpoint: { address: 'http://127.0.0.1:9', username: 'u', secret: 's' },
          harnessContext: h.context,
        }),
      ),
    )
  },
}

/** Required of every harness, Declared or not. */
const ALWAYS = ['launch', 'roots', 'discovery', 'inventory.detectLogin'] as const

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

let world: World
let unregisterFixture: () => void

beforeAll(() => {
  world = buildWorld()
  unregisterFixture = registerTestManifest(fixtureManifest)
  // The daemon's own process is poisoned too: HOME, PATH and every selector.
  vi.stubEnv('HOME', world.decoyHome)
  vi.stubEnv('PATH', [world.decoyBin, process.env.PATH ?? ''].join(delimiter))
  for (const name of SELECTORS) vi.stubEnv(name, world.decoySelectors[name])
})

afterAll(() => {
  vi.unstubAllEnvs()
  unregisterFixture?.()
  rmSync(world.root, { recursive: true, force: true })
})

describe('the poisoned machine (POD-6536)', () => {
  it('the sentinels can see a read on this filesystem', () => {
    const probe = join(world.root, 'atime-probe')
    writeFileSync(probe, 'x')
    const now = Date.now() / 1000
    utimesSync(probe, now - 3 * 86_400, now)
    const before = statSync(probe).atimeMs
    readFileSync(probe)
    expect(statSync(probe).atimeMs).not.toBe(before)
  })

  for (const kind of KINDS) {
    describe(kind, () => {
      const manifest = manifestOf(kind)
      const supported = [
        ...ALWAYS,
        ...sectionStatusesOf(manifest)
          .filter((row) => row.supported)
          .map((row) => row.section),
      ]

      it('has a conformance case for every supported section', () => {
        const missing = supported.filter((section) => !CASES[section] && !NEEDS_MODEL.has(section))
        expect(missing, `${kind}: add a poisoned-machine case for each`).toEqual([])
      })

      for (const section of supported) {
        const reason = NEEDS_MODEL.get(section)
        if (reason) {
          it.skip(`${section} needs a model: ${reason}`, () => {})
          continue
        }
        it(`${section} reaches only the context`, async () => {
          const run = CASES[section]
          if (!run) throw new Error(`no poisoned-machine case for ${kind}.${section}`)
          rmSync(world.records, { recursive: true, force: true })
          mkdirSync(world.records)
          rmSync(world.decoyRan, { force: true })
          armSentinels(world, [
            ...HOME_FOLDERS.map((folder) => join(world.decoyHome, folder)),
            join(world.decoyHome, '.claude.json'),
            ...Object.values(world.decoySelectors),
          ])
          const h = harnessOn(world, kind)
          await run(h)
          await settle(20)

          expect(touchedSentinels(world), `${kind}.${section} reached a decoy`).toEqual([])
          expect(
            existsSync(world.decoyRan) ? readFileSync(world.decoyRan, 'utf8') : '',
            `${kind}.${section} ran the decoy binary`,
          ).toBe('')
          const argv0 = recordedArgv0(world)
          expect(argv0.length, `${kind}.${section}: children recorded`).toBe(h.spawned)
          for (const path of argv0) {
            expect(
              path.startsWith(join(world.installRoot, kind)),
              `${kind}.${section} argv[0]`,
            ).toBe(true)
          }
        })
      }
    })
  }
})
