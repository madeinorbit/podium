/**
 * A LIVE CODEX ENGINE WHOSE LISTENER FILE WAS REMOVED, RELAUNCHED ON ITS OWN
 * LABEL (POD-4611, REVIEW-4438 A2 guard b).
 *
 * The session layer mints each engine's Unix listener address and removes the
 * file when it destroys the engine. What happens when the file is gone while
 * the engine is NOT — a swept runtime root, an operator's `rm` — and the
 * session is launched again on the same label?
 *
 * Pinned as it is, with the real podium-host `--no-pty`:
 *   - `startEngine` is create-or-adopt, so the relaunch ADOPTS THE SURVIVOR:
 *     no second engine is started (the stub records every incarnation).
 *   - The adopted engine keeps the argv it was born with, so it never listens
 *     on the freshly minted address. The launch fails LOUDLY as
 *     `EngineBindUnrecoverable` during 'launch', naming the new address, and
 *     the engine is KEPT (§4.8 failure ownership) — still alive afterwards.
 *
 * Generation 1 runs in a child process and is SIGKILLed, so the writer lease
 * frees exactly as a real daemon death frees it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  codexEngineFacts,
  codexScopeLabel,
  createCodexEngineHost,
  EngineBindUnrecoverable,
  type CodexJournalEntry,
} from '@podium/harness/driver/host'
import { manifestFor } from '@podium/harness'
import { asSessionId } from '@podium/model'
import { createDurableProcess } from '@podium/process/durable'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stageRuntimeAttachment } from './attachment-staging'
import { composeEngineEnv, dialEngineSocket, engineSocketRoot } from './host'
import { SERVER_GRACEFUL_EXIT_MS } from './server-teardown-budget'
import { createSessionEngineScope, engineSocketFile } from '../session/engines.js'
import { SessionRegistry } from '../session/registry.js'

const GEN1 = fileURLToPath(new URL('../test-support/codex-socket-removed.gen1.ts', import.meta.url))
const SESSION = asSessionId('46110000-0000-4000-8000-00000000b0b0')
const facts = codexEngineFacts(manifestFor('codex')!)

/** A stub `codex app-server`: records its incarnation, then accepts WebSocket
 *  upgrades on its `--listen` socket and holds every connection open. */
const STUB_CODEX = `
const fs = require('node:fs')
const net = require('node:net')
const crypto = require('node:crypto')
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.149.1\\n')
  process.exit(0)
}
fs.appendFileSync(process.env.STUB_CODEX_INCARNATIONS, process.pid + '\\n')
const listenIx = process.argv.indexOf('--listen')
const sock = process.argv[listenIx + 1].slice('unix://'.length)
try { fs.unlinkSync(sock) } catch {}
net.createServer((socket) => {
  let pending = ''
  let upgraded = false
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    if (upgraded) return
    pending += chunk.toString('latin1')
    const end = pending.indexOf('\\r\\n\\r\\n')
    if (end < 0) return
    upgraded = true
    const key = /sec-websocket-key:[ \\t]*([^\\r\\n]+)/i.exec(pending.slice(0, end))[1].trim()
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: ' + accept, '', ''].join('\\r\\n'))
  })
}).listen(sock)
setInterval(() => {}, 60_000)
`

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\\''")}'`
}

/** The shortest writable system tmp: socket paths must fit sun_path. */
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

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let root = ''
let hostSockets = ''
let xdgRuntime = ''
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'PATH',
  'HOME',
  'PODIUM_STATE_DIR',
  'PODIUM_HOST_SOCKET_DIR',
  'PODIUM_INSTANCE',
  'XDG_RUNTIME_DIR',
  'STUB_CODEX_INCARNATIONS',
]

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-4611-sockrm-'))
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(join(root, 'work'), { recursive: true })
  mkdirSync(join(root, 'home'), { recursive: true })
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  const helper = join(root, 'stub-codex.cjs')
  writeFileSync(helper, STUB_CODEX)
  const wrapper = join(binDir, 'codex')
  writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`)
  chmodSync(wrapper, 0o755)
  hostSockets = shortSockRoot('pod-4611-hs-')
  xdgRuntime = shortSockRoot('pod-4611-xr-')
  process.env.PATH = `${binDir}:${savedEnv.PATH ?? ''}`
  process.env.HOME = join(root, 'home')
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_HOST_SOCKET_DIR = hostSockets
  process.env.PODIUM_INSTANCE = 'sockrm'
  process.env.XDG_RUNTIME_DIR = xdgRuntime
  process.env.STUB_CODEX_INCARNATIONS = join(root, 'incarnations.txt')
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
  if (hostSockets) rmSync(hostSockets, { recursive: true, force: true })
  if (xdgRuntime) rmSync(xdgRuntime, { recursive: true, force: true })
})

function incarnations(): string[] {
  const path = join(root, 'incarnations.txt')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0)
}

describe('a live codex engine whose listener file was removed (POD-4611)', () => {
  it('a relaunch on the same label adopts the survivor, starts no second engine, and fails loudly', async () => {
    const label = codexScopeLabel(facts, SESSION)
    const durable = createDurableProcess('host', { host: true, abduco: false })
    const sessionEngines = createSessionEngineScope(durable, {
      sessions: new SessionRegistry(),
      socketRoot: engineSocketRoot,
    })
    const errFd = openSync(join(root, 'gen1-stderr.txt'), 'w')
    let gen1: ChildProcess | undefined = spawn(
      process.execPath,
      ['--conditions=@podium/source', GEN1],
      {
        env: { ...process.env, GEN1_SESSION: SESSION, GEN1_WORKDIR: join(root, 'work') },
        stdio: ['ignore', 'pipe', errFd],
      },
    )
    try {
      // GENERATION 1: one engine, launched and bound at a minted address.
      let output = ''
      const ready = await new Promise<{ address: string; pid: number; key: string }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            let stderr = ''
            try {
              stderr = readFileSync(join(root, 'gen1-stderr.txt'), 'utf8').slice(-2000)
            } catch {
              // No stderr captured.
            }
            reject(new Error(`gen1 never became ready: ${output}\n${stderr}`))
          }, 120_000)
          timer.unref?.()
          gen1?.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8')
            const match = /^READY (\{.*\})$/m.exec(output)
            if (match) {
              clearTimeout(timer)
              resolve(JSON.parse(match[1]!))
            }
          })
          gen1?.once('exit', (code) => reject(new Error(`gen1 exited early (${code}): ${output}`)))
        },
      )
      expect(ready.key).toBe(label)
      const socketFile = engineSocketFile(ready.address)!
      expect(existsSync(socketFile)).toBe(true)
      expect(incarnations()).toHaveLength(1)
      const enginePid = Number(incarnations()[0])

      // THE DAEMON DIES; the engine does not.
      const exited = new Promise<void>((resolve) => gen1?.once('exit', () => resolve()))
      gen1.kill('SIGKILL')
      await exited
      gen1 = undefined
      await wait(200)
      expect(alive(enginePid)).toBe(true)
      expect(await sessionEngines.engineAlive(label)).toBe(true)

      // THE LISTENER FILE GOES; the engine is still listening on nothing.
      rmSync(socketFile, { force: true })

      // GENERATION 2 relaunches the same session, on the same label.
      const host = createCodexEngineHost({
        facts,
        engines: sessionEngines.ownerFor<CodexJournalEntry>(facts.journalNamespace),
        supervision: sessionEngines,
        stageAttachment: stageRuntimeAttachment,
        resources: () => undefined,
        buildEnv: composeEngineEnv,
        gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
        checkVersion: async () => ({ drivable: true as const }),
        dialSocket: sessionEngines.dialerFor(dialEngineSocket),
      })
      const error = await host.launch({ sessionId: SESSION, workdir: join(root, 'work') }).then(
        () => undefined,
        (err: unknown) => err,
      )

      // ADOPTED, NOT DOUBLED: the survivor is the only engine there has been.
      expect(incarnations()).toEqual([String(enginePid)])
      // LOUD, NOT A TRANSPORT TO NOWHERE: the fresh address never answers.
      expect(error).toBeInstanceOf(EngineBindUnrecoverable)
      expect((error as EngineBindUnrecoverable).during).toBe('launch')
      expect((error as EngineBindUnrecoverable).address).toMatch(/^unix:\/\//)
      expect((error as EngineBindUnrecoverable).address).not.toBe(ready.address)
      // KEPT (§4.8): the engine outlives the failed bind for an operator decision.
      expect(alive(enginePid)).toBe(true)
      expect(await sessionEngines.engineAlive(label)).toBe(true)
    } finally {
      gen1?.kill('SIGKILL')
      closeSync(errFd)
      await sessionEngines.destroyEngine(label, SESSION).catch(() => undefined)
    }
  }, 180_000)
})
