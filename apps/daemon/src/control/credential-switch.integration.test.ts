/**
 * A SESSION SWITCHED TO ANOTHER CREDENTIAL CONTINUES ITS CONVERSATION
 * (credential management §9; epic plan Task 11, acceptance 1 and 6).
 *
 * The fixture harness on both of its drivers, through the daemon's real paths:
 *
 *  - terminal: the real spawn handler on a real PTY (the direct-pty double, no
 *    process host), parked, the conversation placed, spawned again with resume;
 *  - headless: two hosted turns under the real podium-host, the conversation
 *    placed between them.
 *
 * The stand-in `fixture-agent` keeps its conversation in
 * `$HOME/.fixture/sessions/<id>.jsonl` and, like Codex (POD-6893 §3), writes a
 * `reasoning` record only the account that wrote it may send again: it refuses
 * a conversation holding another account's reasoning. Asked for the code word,
 * it answers from the conversation's earlier turn. So an answer proves the
 * resume, the new credential reached the process, and the old account's
 * reasoning was left out of the placed copy. Planted secrets are fake.
 *
 * Integration lane: the headless half needs the podium-host binary.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentLaunchCommand, clearTestManifests, harnessContext } from '@podium/harness'
import { fixtureManifest } from '@podium/harness/adapters/fixture'
import { acknowledgeHostedTurn, runHostedHeadlessTurn } from '@podium/harness/driver/host'
import { asSessionId, type SessionId } from '@podium/model'
import {
  createDurableProcess,
  directPtyDurableForTests,
  liveHostSocket,
} from '@podium/process/durable'
import type { AccessField, BuiltinHarnessKind } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prepareConversation } from '../homes/conversation'
import { createSessionEngineScope } from '../session/engines.js'
import { SessionRegistry } from '../session/registry.js'
import { testTerminalRuntime } from '../session/testing.js'
import {
  FIXTURE_AGENT,
  fixtureSnapshot,
  registerFixtureHarness,
  restartTurn,
} from '../test-support/headless-turn-restart.shared.js'
import { deliveryOverlay, memoryMarkers, SessionAccessStore } from './access'
import type { DaemonContext } from './context'
import { launchTerminalProcess, sessionHandlers } from './session'
import { headlessTurnChildEnv } from './session-env.js'

const VARIABLE = 'FIXTURE_API_KEY'
const KEY_A = 'sk-FAKE-switch-account-a'
const KEY_B = 'sk-FAKE-switch-account-b'
const CRED_A = 'cred_00000000-0000-4000-8000-0000000000aa'
const CRED_B = 'cred_00000000-0000-4000-8000-0000000000bb'

const access = (credentialId: string, secret: string): AccessField => ({
  credentialId,
  delivery: { kind: 'env', variable: VARIABLE, secret },
})

/**
 * The stand-in. `exec --session-id ID PROMPT` answers one turn (headless);
 * otherwise it reads turns from its terminal, the conversation named by
 * `--resume ID` or, new, by the Podium session id.
 */
const STAND = `#!/bin/sh
# The terminal launch hands the child no command environment of its own.
PATH="/usr/bin:/bin:$PATH"; export PATH
key="\${${VARIABLE}-none}"
id="$PODIUM_SESSION_ID"
mode=terminal
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    exec) mode=exec ;;
    --resume|--session-id) id="$2"; shift ;;
    --*) shift ;;
    *) prompt="$1" ;;
  esac
  shift
done
dir="$HOME/.fixture/sessions"
mkdir -p "$dir"
file="$dir/$id.jsonl"
turn() {
  if [ -f "$file" ] && grep '"role":"reasoning"' "$file" | grep -v "\\"account\\":\\"$key\\"" >/dev/null; then
    printf 'fixture error: invalid_encrypted_content\\n'
    return 1
  fi
  printf '{"v":1,"id":"u%s","role":"user","text":"%s"}\\n' "$$" "$1" >> "$file"
  word=$(sed -n 's/.*"role":"user".*code word is \\([A-Z0-9-]*\\).*/\\1/p' "$file" | head -n 1)
  case "$1" in
    *"code word did I give"*) answer="$word" ;;
    *) answer="noted" ;;
  esac
  printf '{"v":1,"role":"reasoning","account":"%s","text":"hidden"}\\n' "$key" >> "$file"
  printf '{"v":1,"id":"a%s","role":"agent","text":"%s"}\\n' "$$" "$answer" >> "$file"
  printf 'fixture answer: %s key=%s\\n' "$answer" "$key"
}
if [ "$mode" = exec ]; then
  turn "$prompt"
  exit $?
fi
printf 'fixture ready %s\\n' "$id"
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d '\\r')
  [ -n "$line" ] && turn "$line"
done
`

let root = ''
let stand = ''
let hostSockets = ''
const savedEnv: Record<string, string | undefined> = {}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate: () => boolean | Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(25)
  }
}

function shortSockRoot(tag: string): string {
  for (const base of ['/tmp', '/var/tmp', tmpdir()]) {
    try {
      return mkdtempSync(join(base, tag))
    } catch {
      // Next candidate.
    }
  }
  throw new Error('no writable tmp base for podium-host sockets')
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-switch-'))
  mkdirSync(join(root, 'bin'), { recursive: true })
  for (const key of [
    'HOME',
    'PODIUM_STATE_DIR',
    'PODIUM_HOST_SOCKET_DIR',
    'PODIUM_INSTANCE',
    'PODIUM_NO_SCOPE',
    VARIABLE,
  ]) {
    savedEnv[key] = process.env[key]
  }
  hostSockets = shortSockRoot('pod-sw-hs-')
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_HOST_SOCKET_DIR = hostSockets
  process.env.PODIUM_INSTANCE = 'switch'
  process.env.PODIUM_NO_SCOPE = '1'
  delete process.env[VARIABLE]
  stand = join(root, 'bin', 'fixture-agent')
  writeFileSync(stand, STAND)
  chmodSync(stand, 0o755)
  registerFixtureHarness()
})

afterAll(() => {
  clearTestManifests()
  vi.unstubAllEnvs()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
  if (hostSockets) rmSync(hostSockets, { recursive: true, force: true })
})

function newHome(tag: string): { home: string; work: string } {
  const dir = mkdtempSync(join(root, tag))
  const home = join(dir, 'home')
  const work = join(dir, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return { home, work }
}

/** The daemon's placement between the two runs: account A → account B, one home. */
async function placeForB(home: string, conversationId: string) {
  const placed = await prepareConversation(
    { account: { home, env: {} } },
    {
      agentKind: FIXTURE_AGENT as never,
      cwd: '/',
      resume: { kind: 'fixture-session', value: conversationId },
      toHomeId: 'default',
      account: CRED_B,
      fromAccount: CRED_A,
    },
  )
  expect(placed).toMatchObject({ ok: true, placed: 'rewritten', droppedReasoning: true })
  const sessions = join(home, '.fixture', 'sessions')
  const original = readdirSync(sessions).find((name) =>
    name.startsWith(`${conversationId}.jsonl.before-switch-`),
  )
  expect(original, 'the original is kept beside the copy').toBeDefined()
  expect(readFileSync(join(sessions, original as string), 'utf8')).toContain(`"account":"${KEY_A}"`)
  expect(readFileSync(join(sessions, `${conversationId}.jsonl`), 'utf8')).not.toContain(
    '"role":"reasoning"',
  )
}

describe('terminal driver: an idle session switches and answers about an earlier turn', () => {
  function daemonContext(home: string) {
    const sent: DaemonMessage[] = []
    let output = ''
    const ctx = {
      send: (m: DaemonMessage) => sent.push(m),
      machineId: 'local',
      instanceId: 'switch',
      durableLabelFor: (id: string) => `podium-switch-${id}`,
      sessions: new SessionRegistry(),
      homeDir: home,
      backend: 'none',
      durable: directPtyDurableForTests(),
      // The fixture's own launch argv (its `--resume`), run by the stand-in.
      launch: (kind: string, opts: Parameters<typeof agentLaunchCommand>[1]) =>
        kind === FIXTURE_AGENT
          ? { ...fixtureManifest.launch(opts as never), cmd: stand }
          : agentLaunchCommand(kind as never, opts),
      settingsDir: join(home, 'settings'),
      outputScheduler: {
        enqueue: (_id: string, data: string) => {
          output += Buffer.from(data, 'base64').toString('utf8')
        },
        remove: () => {},
      },
      observers: { initSessionObservers: () => {}, clearSession: () => {} },
      sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
      primeInjector: { reset: () => {} },
      sessionBinding: {
        transition: async (input: { event: 'spawn' }) => ({
          status: 'unchanged' as const,
          event: input.event,
          binding: {} as never,
        }),
      },
      hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
      agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
      access: new SessionAccessStore({ markers: memoryMarkers() }),
    } as unknown as DaemonContext
    ctx.agentRuntime = testTerminalRuntime(
      ctx,
      launchTerminalProcess,
    ) as unknown as DaemonContext['agentRuntime']
    return { ctx, sent, output: () => output }
  }

  async function run(
    h: ReturnType<typeof daemonContext>,
    sessionId: SessionId,
    frameAccess: AccessField,
    resume: string | undefined,
    line: string,
    expected: string,
  ) {
    const binds = h.sent.filter((m) => m.type === 'bind').length
    await sessionHandlers.spawn(h.ctx, {
      type: 'spawn',
      sessionId,
      agentKind: FIXTURE_AGENT,
      cwd: process.cwd(),
      geometry: { cols: 120, rows: 30 },
      binding: {
        transitionId: `switch:${sessionId}:${binds}`,
        machineAccess: 'allowed',
        principal: { kind: 'user', userId: 'switch-test-user' },
      },
      ...(resume ? { resume: { kind: 'fixture-session', value: resume } } : {}),
      access: frameAccess,
    } as never)
    await waitFor(
      () =>
        h.sent.filter((m) => m.type === 'bind').length > binds ||
        h.sent.some((m) => m.type === 'spawnError'),
      15_000,
      'the bind',
    )
    expect(h.sent.find((m) => m.type === 'spawnError')).toBeUndefined()
    const terminal = h.ctx.sessions.get(sessionId)?.terminal
    if (!terminal) throw new Error('no terminal for the session')
    await waitFor(() => h.output().includes('fixture ready'), 15_000, 'the stand-in')
    terminal.writeBase64(Buffer.from(`${line}\n`, 'utf8').toString('base64'))
    await waitFor(() => h.output().includes(expected), 15_000, expected).catch((error) => {
      throw new Error(`${error}: the child printed ${JSON.stringify(h.output().slice(-1500))}`)
    })
    const pid = terminal.pid
    terminal.park()
    await waitFor(
      () => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      },
      5_000,
      'the child to end',
    )
    h.ctx.sessions.delete(sessionId)
  }

  it('turn 1 on account A, placed for account B, resumed: it names the word on B', async () => {
    const { home } = newHome('t')
    vi.stubEnv('HOME', home)
    vi.stubEnv('SHELL', '/bin/sh')
    const h = daemonContext(home)
    const sessionId = asSessionId('sess-switch-terminal')

    await run(
      h,
      sessionId,
      access(CRED_A, KEY_A),
      undefined,
      'My code word is FIG-2.',
      `fixture answer: noted key=${KEY_A}`,
    )
    expect(existsSync(join(home, '.fixture', 'sessions', `${sessionId}.jsonl`))).toBe(true)

    await placeForB(home, sessionId)

    await run(
      h,
      sessionId,
      access(CRED_B, KEY_B),
      sessionId,
      'What code word did I give you?',
      `fixture answer: FIG-2 key=${KEY_B}`,
    )
  }, 120_000)
})

describe('headless driver: a per-turn session switches between turns and answers', () => {
  it('turn 1 on account A, placed for account B, turn 2 on B names the word', async () => {
    const { home, work } = newHome('h')
    const sessionId = 'hswitch01'
    const snapshot = fixtureSnapshot(stand)
    const store = new SessionAccessStore({ markers: memoryMarkers() })
    const engines = createSessionEngineScope(createDurableProcess(), {
      sessions: new SessionRegistry(),
      access: store,
    })

    const turn = async (turnId: string, credential: AccessField, prompt: string) => {
      store.remember(asSessionId(sessionId), credential, FIXTURE_AGENT)
      const credentialEnv = deliveryOverlay(
        FIXTURE_AGENT,
        await store.awaitAccess(asSessionId(sessionId)),
      ).env
      const built = restartTurn({
        sessionId,
        turnId,
        cwd: work,
        agentHome: home,
        files: {
          incarnations: join(home, 'inc'),
          homeReceipt: join(home, 'hr'),
          release: '',
          done: '',
        },
        snapshot,
      })
      built.spec.prompt = prompt
      const handle = runHostedHeadlessTurn(
        {
          owner: engines,
          childEnv: (invocation) => {
            const { env, strip } = headlessTurnChildEnv({
              context: harnessContext(snapshot, FIXTURE_AGENT as BuiltinHarnessKind, home),
              credentialEnv,
              ...(built.spec.env ? { instanceEnv: built.spec.env } : {}),
              ...invocation,
            })
            return { env, stripEnv: strip }
          },
        },
        { spec: built.spec, identity: built.identity, snapshot, emit: () => {} },
      )
      try {
        return (await handle.done).output
      } finally {
        await acknowledgeHostedTurn(engines, built.label, built.identity)
        await waitFor(
          async () => (await liveHostSocket(built.label)) === undefined,
          10_000,
          'host release',
        )
      }
    }

    expect(await turn('turn-1', access(CRED_A, KEY_A), 'My code word is PLUM-3.')).toBe(
      `fixture answer: noted key=${KEY_A}`,
    )
    // The conversation the daemon named for the session (`--session-id`).
    const files = readdirSync(join(home, '.fixture', 'sessions'))
    expect(files).toHaveLength(1)
    await placeForB(home, (files[0] as string).replace(/\.jsonl$/, ''))
    expect(await turn('turn-2', access(CRED_B, KEY_B), 'What code word did I give you?')).toBe(
      `fixture answer: PLUM-3 key=${KEY_B}`,
    )
  }, 240_000)
})
