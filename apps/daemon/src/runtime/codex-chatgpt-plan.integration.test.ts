/**
 * CODEX ON A CHATGPT PLAN, WITH A REAL CODEX (credential management §11
 * "Codex"; epic Task 15, acceptance 1, 3, 4, 5 and 6 on the engine).
 *
 * A real `codex app-server` under the real podium-host, started the way the
 * daemon starts it: the session's access is held in a `SessionAccessStore`, and
 * `SessionEngineScope.startEngine` applies it, so the plan's provider flags
 * come from the accepted line and the token from the access field. The
 * provider is a fake Responses endpoint on 127.0.0.1 that knows each token's
 * expiry on a clock the test controls, refuses an expired one the way OpenAI
 * does (401 `token_expired`), and answers a question about an earlier code word
 * only when that word is in the conversation it was sent.
 *
 * The one change to what production runs: `codex` here is a wrapper that
 * points the provider's `base_url` at the fake (and records its argv), then
 * `exec`s the real binary. Everything else is as shipped.
 *
 * Needs Codex 0.169 or later: `PODIUM_CODEX_BIN`, or `codex` on PATH. Without
 * one the suite is skipped and says so. Planted tokens are obviously fake.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manifestFor } from '@podium/harness'
import {
  type AgentSessionHandle,
  type CodexJournalEntry,
  codexEngineFacts,
  codexScopeLabel,
  createCodexEngineHost,
  createCodexRuntime,
} from '@podium/harness/driver/host'
import { createMemoryDriverSlots } from '@podium/harness/driver/testing'
import { asSessionId, type SessionId } from '@podium/model'
import { createDurableProcess } from '@podium/process/durable'
import type { AccessField } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memoryMarkers, SessionAccessStore } from '../control/access'
import { createSessionEngineScope } from '../session/engines.js'
import { SessionRegistry } from '../session/registry.js'
import { stubHarnessContext } from '../test-support/stub-harness-context'
import { stageRuntimeAttachment } from './attachment-staging'
import { dialEngineSocket, engineEnvBuilder, engineSocketRoot } from './host'
import { SERVER_GRACEFUL_EXIT_MS } from './server-teardown-budget'

const facts = codexEngineFacts(manifestFor('codex')!)
const PLAN_BASE = 'https://api.openai.com/v1'
const MIN = 60_000

/** The real Codex this host can run, or undefined. */
function realCodex(): string | undefined {
  const candidates = [process.env.PODIUM_CODEX_BIN, 'codex'].filter(Boolean) as string[]
  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 20_000 })
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(version)
      if (match && (Number(match[1]) > 0 || Number(match[2]) >= 169)) {
        return candidate.includes('/') ? candidate : execFileSync('which', [candidate], { encoding: 'utf8' }).trim()
      }
    } catch {
      // Not this one.
    }
  }
  return undefined
}

const CODEX = realCodex()
if (!CODEX) {
  console.warn(
    'codex-chatgpt-plan.integration: SKIPPED, no Codex 0.169+ (set PODIUM_CODEX_BIN or put codex on PATH)',
  )
}
const describeWithCodex = CODEX ? describe : describe.skip

// ---------------------------------------------------------------------------
// The fake provider
// ---------------------------------------------------------------------------

interface ProviderCall {
  token: string
  at: number
  expired: boolean
  /** The whole conversation Codex sent, as text. */
  input: string
  answered: string
}

class FakeProvider {
  now = Date.parse('2026-11-17T09:00:00Z')
  readonly expiry = new Map<string, number>()
  readonly calls: ProviderCall[] = []
  /** The next answer is a function call, and the clock passes `advanceMs` after it. */
  nextToolCall: { advanceMs: number } | undefined
  private server: Server | undefined
  base = ''

  issue(token: string, lifetimeMs: number): AccessField {
    this.expiry.set(token, this.now + lifetimeMs)
    return {
      credentialId: 'cred_00000000-0000-4000-8000-0000000c0015',
      delivery: { kind: 'env', variable: 'ACCESS_TOKEN', secret: token },
    }
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
      })
      req.on('end', () => this.answer(req.method ?? 'GET', req.url ?? '', req.headers, body, res))
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`
  }

  stop(): void {
    this.server?.close()
  }

  private answer(
    method: string,
    url: string,
    headers: Record<string, string | string[] | undefined>,
    body: string,
    res: import('node:http').ServerResponse,
  ): void {
    if (method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [], models: [] }))
      return
    }
    if (!url.endsWith('/responses')) {
      res.writeHead(404).end()
      return
    }
    const token = String(headers.authorization ?? '').replace(/^Bearer /, '')
    const expiresAt = this.expiry.get(token)
    const expired = expiresAt === undefined || expiresAt <= this.now
    let input = ''
    try {
      input = JSON.stringify((JSON.parse(body) as { input?: unknown }).input ?? '')
    } catch {
      input = body
    }
    if (expired) {
      this.calls.push({ token, at: this.now, expired, input, answered: '401' })
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'Provided authentication token is expired. Please try signing in again.',
            type: null,
            code: 'token_expired',
            param: null,
          },
          status: 401,
        }),
      )
      return
    }
    const sse = (type: string, data: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    const responseId = `resp_${this.calls.length + 1}`
    const usage = {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12,
    }
    let item: Record<string, unknown>
    let answered: string
    const tool = this.nextToolCall
    if (tool && !input.includes('function_call_output')) {
      answered = 'tool-call'
      item = {
        type: 'function_call',
        id: `fc_${this.calls.length + 1}`,
        call_id: `call_${this.calls.length + 1}`,
        name: 'update_plan',
        arguments: JSON.stringify({ plan: [{ step: 'think', status: 'in_progress' }] }),
      }
    } else {
      const word = /HELIOTROPE-\d+|CINNABAR-\d+|VERDIGRIS-\d+/.exec(
        input.includes('What was the code word') ? input : '',
      )?.[0]
      answered = input.includes('What was the code word') ? (word ?? 'I do not know') : 'noted'
      item = {
        type: 'message',
        role: 'assistant',
        id: `msg_${this.calls.length + 1}`,
        status: 'completed',
        content: [{ type: 'output_text', text: answered, annotations: [] }],
      }
    }
    this.calls.push({ token, at: this.now, expired, input, answered })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse('response.created', { response: { id: responseId } }))
    res.write(sse('response.output_item.done', { output_index: 0, item }))
    res.end(
      sse('response.completed', { response: { id: responseId, status: 'completed', usage } }),
    )
    if (answered === 'tool-call' && tool) {
      // The token runs out while Codex works on the tool's result.
      this.now += tool.advanceMs
      this.nextToolCall = undefined
    }
  }
}

// ---------------------------------------------------------------------------
// The rig: real podium-host, real engine scope with the session's access
// ---------------------------------------------------------------------------

let root = ''
let home = ''
let wrapper = ''
let argvLog = ''
const provider = new FakeProvider()
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['HOME', 'PODIUM_STATE_DIR', 'PODIUM_HOST_SOCKET_DIR', 'PODIUM_INSTANCE', 'XDG_RUNTIME_DIR']
const shortDirs: string[] = []

function shortDir(tag: string): string {
  for (const base of ['/tmp', '/var/tmp', tmpdir()]) {
    try {
      const dir = mkdtempSync(join(base, tag))
      shortDirs.push(dir)
      return dir
    } catch {
      // Next candidate.
    }
  }
  throw new Error('no writable tmp base for sockets')
}

beforeAll(async () => {
  if (!CODEX) return
  await provider.start()
  root = mkdtempSync(join(tmpdir(), 'podium-6902-plan-'))
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(root, 'work'), { recursive: true })
  argvLog = join(root, 'argv.log')
  wrapper = join(root, 'codex')
  // Points the provider at the fake and records argv; every other byte of the
  // command is what the daemon composed.
  writeFileSync(
    wrapper,
    `#!/bin/bash
old=${JSON.stringify(PLAN_BASE)}
new=${JSON.stringify(provider.base)}
args=()
for a in "$@"; do args+=("\${a//"$old"/"$new"}"); done
printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}
exec ${JSON.stringify(CODEX)} "\${args[@]}"
`,
  )
  chmodSync(wrapper, 0o755)
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  // A home with no Codex login: nothing but an empty directory.
  process.env.HOME = home
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_HOST_SOCKET_DIR = shortDir('p6902-hs-')
  process.env.PODIUM_INSTANCE = 'plan6902'
  process.env.XDG_RUNTIME_DIR = shortDir('p6902-xr-')
}, 60_000)

afterAll(() => {
  provider.stop()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (root) rmSync(root, { recursive: true, force: true })
  for (const dir of shortDirs) rmSync(dir, { recursive: true, force: true })
})

interface Rig {
  access: SessionAccessStore
  start(sessionId: SessionId, token: AccessField): Promise<Live>
  resume(sessionId: SessionId, threadId: string): Promise<Live>
  dispose(): Promise<void>
}

interface Live {
  handle: AgentSessionHandle
  /** Send a turn and wait for it to complete or fail. */
  turn(text: string): Promise<'completed' | 'failed'>
}

function rig(): Rig {
  const access = new SessionAccessStore({ markers: memoryMarkers() })
  const durable = createDurableProcess()
  const engines = createSessionEngineScope(durable, {
    sessions: new SessionRegistry(),
    socketRoot: engineSocketRoot,
    access,
  })
  const context = stubHarnessContext('codex', wrapper, { home })
  const host = createCodexEngineHost({
    facts,
    engines: engines.ownerFor<CodexJournalEntry>(facts.journalNamespace),
    supervision: engines,
    stageAttachment: stageRuntimeAttachment,
    resources: () => undefined,
    buildEnv: engineEnvBuilder(() => ({})),
    gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
    checkVersion: async () => ({ drivable: true as const }),
    harnessContextFor: async () => context,
    dialSocket: engines.dialerFor(dialEngineSocket),
  })
  let next: SessionId | undefined
  const started = new Set<SessionId>()
  const runtime = createCodexRuntime(
    {
      ...host,
      mintSessionId: () => {
        if (!next) throw new Error('no session id staged')
        return next
      },
    },
    createMemoryDriverSlots(),
  )
  const spec = {
    harness: 'codex' as const,
    harnessContext: context,
    selection: {
      auth: 'subscription' as const,
      platform: 'linux' as const,
      available: ['codex-app-server'],
    },
    workdir: join(root, 'work'),
    model: {},
    instructions: { supported: false as const, reason: 'test' },
    mcpServers: { supported: false as const, reason: 'test' },
  }
  const live = (handle: AgentSessionHandle): Live => {
    const ends: ('completed' | 'failed')[] = []
    void (async () => {
      try {
        for await (const event of handle.events('bootstrap')) {
          if (event.t === 'turn' && (event.ev.ev === 'completed' || event.ev.ev === 'failed')) {
            ends.push(event.ev.ev)
          }
        }
      } catch {
        // The stream ends with the session.
      }
    })()
    return {
      handle,
      async turn(text) {
        const before = ends.length
        await handle.send({ text }, { origin: 'human', delivery: 'when-ready' })
        const deadline = Date.now() + 120_000
        while (ends.length === before) {
          if (Date.now() > deadline) throw new Error(`turn did not end: ${text}`)
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return ends[before]!
      },
    }
  }
  return {
    access,
    async start(sessionId, token) {
      access.remember(sessionId, token, 'codex')
      started.add(sessionId)
      next = sessionId
      return live(await runtime.createWithId(sessionId, spec))
    },
    async resume(sessionId, threadId) {
      next = sessionId
      return live(await runtime.driver.resume({ kind: 'codex-thread', value: threadId }, spec))
    },
    async dispose() {
      runtime.dispose()
      // Engines outlive their driver by design: end them here.
      for (const sessionId of started) {
        await engines
          .destroyEngine(codexScopeLabel(facts, sessionId), sessionId)
          .catch(() => undefined)
      }
    },
  }
}

/** The token replacement the server performs at a turn boundary: new access, stop, resume. */
async function replaceToken(r: Rig, live: Live, sessionId: SessionId, token: AccessField) {
  const threadId = live.handle.binding.resume?.value
  if (!threadId) throw new Error('no thread to resume')
  r.access.remember(sessionId, token)
  const parked = await live.handle.hibernate()
  expect(parked).toEqual({ ok: true })
  const resumed = await r.resume(sessionId, threadId)
  expect(resumed.handle.binding.resume?.value).toBe(threadId)
  return resumed
}

/** Every file under `dir`, as text. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      const stat = statSync(path, { throwIfNoEntry: false })
      if (!stat) continue
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile() && stat.size < 20_000_000) out.push(path)
    }
  }
  walk(dir)
  return out
}

describeWithCodex('Codex on a ChatGPT plan, real engine (epic Task 15)', () => {
  it('runs in a home with no Codex login, restarts on a new token, resumes its thread and keeps its context (acceptance 1, 3, 5)', async () => {
    const r = rig()
    const session = asSessionId('00000000-0000-4000-8000-0000000d0015')
    const first = 'tok-FAKE-plan-first-0015'
    const second = 'tok-FAKE-plan-second-0015'
    try {
      expect(existsSync(join(home, '.codex', 'auth.json'))).toBe(false)
      let live = await r.start(session, provider.issue(first, 60 * MIN))
      expect(await live.turn('Remember this code word for later: HELIOTROPE-47. Reply with just "noted".')).toBe('completed')

      // Acceptance 1, on the real start: the provider flags are in argv, the token is not.
      const argv = readFileSync(argvLog, 'utf8')
      expect(argv).toContain('model_provider="podium_chatgpt_plan"')
      expect(argv).toContain('model_providers.podium_chatgpt_plan.env_key="ACCESS_TOKEN"')
      expect(argv).not.toContain('tok-FAKE')

      // 35 minutes on, at a turn boundary: a new token, the engine restarts and resumes.
      provider.now += 35 * MIN
      live = await replaceToken(r, live, session, provider.issue(second, 60 * MIN))
      expect(
        await live.turn('What was the code word I asked you to remember earlier in this conversation? Reply with just the word.'),
      ).toBe('completed')

      const answered = provider.calls.filter((c) => c.answered !== '401')
      expect(answered.at(-1)?.answered).toBe('HELIOTROPE-47')
      expect(answered.at(-1)?.token).toBe(second)
      expect(provider.calls.some((c) => c.token === first)).toBe(true)
      // Acceptance 3: the endpoint received no request with an expired token.
      expect(provider.calls.filter((c) => c.expired)).toEqual([])

      // Acceptance 5: no login file, and no token anywhere in the home.
      expect(existsSync(join(home, '.codex', 'auth.json'))).toBe(false)
      const files = filesUnder(home)
      expect(files.length).toBeGreaterThan(0)
      const holding = files.filter((path) => {
        const text = readFileSync(path, 'latin1')
        return text.includes(first) || text.includes(second)
      })
      expect(holding).toEqual([])
    } finally {
      await r.dispose()
    }
  }, 300_000)

  it('a token that runs out during a long turn fails it readably; the next turn runs on a fresh token, same thread (acceptance 4)', async () => {
    const r = rig()
    const session = asSessionId('00000000-0000-4000-8000-0000000e0015')
    const short = 'tok-FAKE-plan-short-0015'
    const fresh = 'tok-FAKE-plan-fresh-0015'
    try {
      let live = await r.start(session, provider.issue(short, 30 * MIN))
      expect(await live.turn('Remember this code word for later: CINNABAR-12. Reply with just "noted".')).toBe('completed')
      const threadId = live.handle.binding.resume?.value
      // The next turn makes a tool call; the token runs out while Codex works on it.
      provider.nextToolCall = { advanceMs: 31 * MIN }
      expect(await live.turn('Plan the next step, then say done.')).toBe('failed')
      const state = await live.handle.state()
      expect(state.phase).toBe('errored')
      expect(state.error?.class).toBe('provider-error')
      expect(state.error?.retryable).toBe(true)
      expect(state.error?.detail).toContain('expired during this turn')
      expect(provider.calls.some((c) => c.token === short && c.expired)).toBe(true)

      // The waiting restart runs at this boundary, with a fresh token.
      live = await replaceToken(r, live, session, provider.issue(fresh, 60 * MIN))
      expect(live.handle.binding.resume?.value).toBe(threadId)
      expect(
        await live.turn('What was the code word I asked you to remember earlier in this conversation? Reply with just the word.'),
      ).toBe('completed')
      const last = provider.calls.at(-1)
      expect(last?.token).toBe(fresh)
      expect(last?.answered).toBe('CINNABAR-12')
    } finally {
      await r.dispose()
    }
  }, 300_000)

  it('two sessions on one plan on one machine both survive a token replacement (acceptance 6)', async () => {
    const r = rig()
    const one = asSessionId('00000000-0000-4000-8000-0000000f0015')
    const two = asSessionId('00000000-0000-4000-8000-000000100015')
    const before = 'tok-FAKE-plan-shared-before-0015'
    const after = 'tok-FAKE-plan-shared-after-0015'
    try {
      const firstToken = provider.issue(before, 60 * MIN)
      let a = await r.start(one, firstToken)
      let b = await r.start(two, firstToken)
      expect(await a.turn('Remember this code word for later: VERDIGRIS-1. Reply with just "noted".')).toBe('completed')
      expect(await b.turn('Remember this code word for later: VERDIGRIS-2. Reply with just "noted".')).toBe('completed')
      provider.now += 35 * MIN
      const renewed = provider.issue(after, 60 * MIN)
      a = await replaceToken(r, a, one, renewed)
      b = await replaceToken(r, b, two, renewed)
      const ask =
        'What was the code word I asked you to remember earlier in this conversation? Reply with just the word.'
      expect(await a.turn(ask)).toBe('completed')
      expect(provider.calls.at(-1)?.answered).toBe('VERDIGRIS-1')
      expect(await b.turn(ask)).toBe('completed')
      expect(provider.calls.at(-1)?.answered).toBe('VERDIGRIS-2')
      expect(provider.calls.slice(-2).map((c) => c.token)).toEqual([after, after])
      expect(provider.calls.filter((c) => c.expired)).toEqual([])
    } finally {
      await r.dispose()
    }
  }, 300_000)
})
