/**
 * A REAL daemon restart leaves codex and opencode engines running and the
 * driver re-adopts them; an in-flight codex turn completes (POD-4433,
 * DONE WHEN 2 — shown red on base, where the engines were daemon children).
 *
 * Generation 1 is a REAL SEPARATE PROCESS (`server-host-survival.gen1.ts`):
 * it launches all three engines under the real podium-host, drives each to a
 * live session (codex holds an OPEN turn), prints its bindings and idles. The
 * test SIGKILLs it — sockets close with the process, freeing the writer lease
 * exactly the way production frees it — then generation 2 (this process)
 * adopts every binding and proves each engine is the SAME process that served
 * generation 1. No respawn, no resumed thread for codex, no fresh `serve` for
 * opencode, no fresh stdio child for grok: the incarnation files each hold one
 * line.
 *
 * Integration lane (real processes, a C compile, real sockets); never unit.
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
import { createGrokAcpRuntime, createOpencodeRuntime, createCodexRuntime } from '@podium/agent-runtime'
import type { RuntimeEvent, SessionBinding } from '@podium/agent-runtime'
import { createDurableProcess } from '@podium/process/durable'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCodexHost, codexScopeLabel } from './codex-app-server'
import { createGrokAcpHost, grokAcpProcessKey } from './grok-acp-server'
import { createOpencodeHost, opencodeScopeLabel } from './opencode-server'

const GEN1 = fileURLToPath(new URL('./server-host-survival.gen1.ts', import.meta.url))

/** A stub `codex app-server`: raw WS over its `--listen` socket, one open turn
 *  held until the COMPLETE file lands, second connections welcome. */
const STUB_CODEX = `
const fs = require('node:fs')
const net = require('node:net')
const crypto = require('node:crypto')
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.149.1\\n')
  process.exit(0)
}
fs.appendFileSync(process.env.GEN1_INCARNATIONS_CODEX, process.pid + '\\n')
const COMPLETE = process.env.GEN1_COMPLETE
const listenIx = process.argv.indexOf('--listen')
const sock = process.argv[listenIx + 1].slice('unix://'.length)
try { fs.unlinkSync(sock) } catch {}
const conns = new Set()
let openTurn = null
const THREAD = 'thr-surv-1'
function encodeFrame(payload) {
  const body = Buffer.from(payload, 'utf8')
  const head = body.length < 126
    ? Buffer.from([0x81, body.length])
    : Buffer.from([0x81, 126, (body.length >> 8) & 0xff, body.length & 0xff])
  return Buffer.concat([head, body])
}
function send(socket, payload) {
  if (!socket.destroyed) socket.write(encodeFrame(payload))
}
function cast(method, params) {
  const line = JSON.stringify(Object.assign({ jsonrpc: '2.0', method }, params ? { params } : {}))
  for (const socket of conns) send(socket, line)
}
function respond(socket, id, result) {
  send(socket, JSON.stringify({ id, result }))
}
function decodeFrames(buffer) {
  const out = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f
    const masked = (buffer[offset + 1] & 0x80) !== 0
    let length = buffer[offset + 1] & 0x7f
    let head = 2
    if (length === 126) {
      if (offset + 4 > buffer.length) break
      length = buffer.readUInt16BE(offset + 2)
      head = 4
    } else if (length === 127) break
    const mask = masked ? buffer.subarray(offset + head, offset + head + 4) : null
    if (masked) head += 4
    if (offset + head + length > buffer.length) break
    const body = Buffer.from(buffer.subarray(offset + head, offset + head + length))
    if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
    if (opcode === 0x8) return { frames: out, close: true }
    if (opcode === 0x1) out.push(body.toString('utf8'))
    offset += head + length
  }
  return { frames: out, close: false, rest: buffer.subarray(offset) }
}
const server = net.createServer((socket) => {
  conns.add(socket)
  let pending = ''
  let upgraded = false
  let rest = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    if (!upgraded) {
      pending += chunk.toString('latin1')
      const end = pending.indexOf('\\r\\n\\r\\n')
      if (end < 0) return
      upgraded = true
      const key = /sec-websocket-key:[ \\t]*([^\\r\\n]+)/i.exec(pending.slice(0, end))[1].trim()
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: ' + accept, '', ''].join('\\r\\n'))
      return
    }
    rest = Buffer.concat([rest, chunk])
    const decoded = decodeFrames(rest)
    rest = decoded.rest || Buffer.alloc(0)
    if (decoded.close) {
      socket.end(Buffer.from([0x88, 0x00]))
      socket.destroy()
      return
    }
    for (const text of decoded.frames) {
      let frame
      try { frame = JSON.parse(text) } catch { continue }
      if (frame.id === undefined) continue
      const params = frame.params || {}
      if (frame.method === 'initialize') {
        respond(socket, frame.id, { userAgent: 'stub/1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' })
      } else if (frame.method === 'getAuthStatus') {
        respond(socket, frame.id, { authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true })
      } else if (frame.method === 'thread/start') {
        respond(socket, frame.id, { thread: { id: THREAD, path: null } })
      } else if (frame.method === 'thread/resume') {
        respond(socket, frame.id, { thread: { id: String(params.threadId), path: null } })
      } else if (frame.method === 'turn/start') {
        openTurn = 'turn-1'
        respond(socket, frame.id, { turn: { id: openTurn, items: [], status: 'inProgress', error: null } })
        cast('turn/started', { threadId: THREAD, turn: { id: openTurn, items: [], status: 'inProgress', error: null } })
      } else {
        respond(socket, frame.id, {})
      }
    }
  })
  socket.on('close', () => void conns.delete(socket))
  socket.on('error', () => {})
})
server.listen(sock)
setInterval(() => {
  if (openTurn && fs.existsSync(COMPLETE)) {
    const turn = { id: openTurn, items: [], status: 'completed', error: null }
    openTurn = null
    cast('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } })
    cast('turn/completed', { threadId: THREAD, turn })
  }
}, 100)
`

/** A stub `opencode serve`: health, one session, an SSE stream held open. */
const STUB_OPENCODE = `
const fs = require('node:fs')
const http = require('node:http')
if (process.argv.includes('--version')) {
  process.stdout.write('1.18.16\\n')
  process.exit(0)
}
fs.appendFileSync(process.env.GEN1_INCARNATIONS_OPENCODE, process.pid + '\\n')
const portIx = process.argv.indexOf('--port')
const server = http.createServer((req, res) => {
  if (req.url === '/global/health') {
    res.statusCode = 200
    res.end('ok')
    return
  }
  if (req.method === 'POST' && (req.url === '/session' || req.url.startsWith('/session?'))) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'ses_surv_1' }))
    return
  }
  if (req.method === 'GET' && req.url === '/session/ses_surv_1/message') {
    res.setHeader('content-type', 'application/json')
    res.end('[]')
    return
  }
  if (req.method === 'GET' && req.url === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    return
  }
  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end('{}')
})
server.listen(Number(process.argv[portIx + 1]), '127.0.0.1')
`

/** A stub `grok agent stdio`: ACP over the pipe, sessions loaded on demand. */
const STUB_GROK = `
const fs = require('node:fs')
if (process.argv.includes('--version')) {
  process.stdout.write('grok 0.2.118\\n')
  process.exit(0)
}
fs.appendFileSync(process.env.GEN1_INCARNATIONS_GROK, process.pid + '\\n')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let boundary = buffer.indexOf('\\n')
  while (boundary >= 0) {
    const line = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 1)
    boundary = buffer.indexOf('\\n')
    if (!line.trim()) continue
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    if (frame.id === undefined) continue
    const params = frame.params || {}
    let result = {}
    if (frame.method === 'initialize') {
      result = { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    } else if (frame.method === 'session/new') {
      result = { sessionId: 'grok-native-1' }
    } else if (frame.method === 'session/load') {
      result = { sessionId: String(params.sessionId || 'grok-native-1') }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n')
  }
})
setInterval(() => {}, 60_000)
`

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\\''")}'`
}

let root = ''
let binDir = ''
let hostSockets = ''
let xdgRuntime = ''
const savedEnv: Record<string, string | undefined> = {}
let gen1: ChildProcess | undefined

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await wait(100)
  }
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

function installStub(name: string, source: string): void {
  const helper = join(root, `stub-${name}.cjs`)
  writeFileSync(helper, source)
  const wrapper = join(binDir, name)
  writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`)
  chmodSync(wrapper, 0o755)
}

function incarnations(name: string): string[] {
  const path = join(root, `incarnations-${name}.txt`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0)
}

/** The tail of generation 1's stderr, for failures that killed it. */
function gen1StderrTail(): string {
  try {
    const text = readFileSync(join(root, 'gen1-stderr.txt'), 'utf8')
    // The throw site (an `at ...` stack) matters more than the zod dump tail.
    const lines = text.split('\n')
    const atIndex = lines.findIndex((line) => /^\s*at /.test(line))
    const head = atIndex >= 0 ? lines.slice(Math.max(0, atIndex - 30), atIndex + 12) : []
    return [...head, '…', ...lines.slice(-25)].join('\n')
  } catch {
    return '(no gen1 stderr captured)'
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-4433-survival-'))
  binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(join(root, 'work'), { recursive: true })
  mkdirSync(join(root, 'home'), { recursive: true })
  for (const key of [
    'PATH',
    'HOME',
    'PODIUM_STATE_DIR',
    'PODIUM_HOST_SOCKET_DIR',
    'PODIUM_INSTANCE',
    'XDG_RUNTIME_DIR',
  ]) {
    savedEnv[key] = process.env[key]
  }
  installStub('codex', STUB_CODEX)
  installStub('opencode', STUB_OPENCODE)
  installStub('grok', STUB_GROK)
  hostSockets = shortSockRoot('pod-4433-sv-')
  xdgRuntime = shortSockRoot('pod-4433-xr-')
  process.env.PATH = `${binDir}:${savedEnv.PATH ?? ''}`
  process.env.HOME = join(root, 'home')
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_HOST_SOCKET_DIR = hostSockets
  process.env.PODIUM_INSTANCE = 'survival'
  process.env.XDG_RUNTIME_DIR = xdgRuntime
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  // Engines are killed by label before the roots go away (see the test).
  rmSync(root, { recursive: true, force: true })
  if (hostSockets) rmSync(hostSockets, { recursive: true, force: true })
  if (xdgRuntime) rmSync(xdgRuntime, { recursive: true, force: true })
})

describe('a real daemon restart re-adopts headless engines (POD-4433)', () => {
  it('leaves codex and opencode running, rebinds every driver, and completes the in-flight codex turn', async () => {
    const completeFile = join(root, 'complete-turn')
    const gen1Env = {
      ...process.env,
      GEN1_ROOT: root,
      GEN1_COMPLETE: completeFile,
      GEN1_INCARNATIONS_CODEX: join(root, 'incarnations-codex.txt'),
      GEN1_INCARNATIONS_OPENCODE: join(root, 'incarnations-opencode.txt'),
      GEN1_INCARNATIONS_GROK: join(root, 'incarnations-grok.txt'),
    }
    const stderrFile = join(root, 'gen1-stderr.txt')
    const errFd = openSync(stderrFile, 'w')

    gen1 = spawn(process.execPath, ['--conditions=@podium/source', GEN1], {
      env: gen1Env,
      stdio: ['ignore', 'pipe', errFd],
    })
    const bindings: Partial<Record<'codex' | 'opencode' | 'grok', SessionBinding>> = {}
    try {
      // Generation 1 boots three engines and three live sessions. Slow on a
      // loaded box: host build, three version probes, three launches.
      let output = ''
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`gen1 never became ready: ${output}`)), 150_000)
        timer.unref?.()
        gen1?.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8')
          for (const line of output.split('\n')) {
            const match = /^READY (codex|opencode|grok) (\{.*\})$/.exec(line.trim())
            if (match?.[1] && match[2]) {
              bindings[match[1] as 'codex' | 'opencode' | 'grok'] = JSON.parse(
                match[2],
              ) as SessionBinding
            }
          }
          if (bindings.codex && bindings.opencode && bindings.grok) {
            clearTimeout(timer)
            resolve()
          }
        })
        gen1?.once('exit', (code) =>
          reject(
            new Error(`gen1 exited ${code} before ready: ${output}\n--- gen1 stderr ---\n${gen1StderrTail()}`),
          ),
        )
        gen1?.once('error', reject)
      })
      const codexBinding = bindings.codex as SessionBinding
      const opencodeBinding = bindings.opencode as SessionBinding
      const grokBinding = bindings.grok as SessionBinding
      const codexPid = codexBinding.process.pid as number
      const opencodePid = opencodeBinding.process.pid as number
      const grokPid = grokBinding.process.pid as number
      expect(codexPid).toBeGreaterThan(0)
      expect(opencodePid).toBeGreaterThan(0)
      expect(grokPid).toBeGreaterThan(0)

      // THE RESTART: SIGKILL the whole daemon generation. Podium-hosts own the
      // engines, so they stay; sockets close with us, freeing the leases.
      gen1.kill('SIGKILL')
      await new Promise<void>((resolve) => {
        if (gen1?.exitCode !== null || gen1?.signalCode !== null) return resolve()
        gen1?.once('exit', () => resolve())
      })
      gen1 = undefined
      await wait(1000)

      // Generation 2: new objects, same dirs, same journals on disk.
      const durable = createDurableProcess('host', { host: true, abduco: false })
      const noResources = () => undefined

      // CODEX: the driver rebinds to the survivor — same pid — and the
      // in-flight turn completes on the adopted handle.
      const codexHost = createCodexHost({ resources: noResources, durable })
      const codexRuntime = createCodexRuntime(codexHost)
      const adoptedCodex = await codexRuntime.driver.adopt(codexBinding)
      expect(adoptedCodex.binding.process.pid).toBe(codexPid)
      expect(incarnations('codex')).toEqual([String(codexPid)])
      // The journal the first generation wrote names the listener adopt found.
      const codexJournal = JSON.parse(
        readFileSync(
          join(
            root,
            'state',
            'codex-app-servers',
            `${encodeURIComponent(codexBinding.sessionId)}.json`,
          ),
          'utf8',
        ),
      ) as { clientAddress?: string }
      expect(codexJournal.clientAddress).toMatch(/^unix:\/\//)
      const collected: RuntimeEvent[] = []
      void (async () => {
        try {
          for await (const event of adoptedCodex.events('bootstrap')) collected.push(event)
        } catch {
          // the stream ends with the session
        }
      })()
      writeFileSync(completeFile, 'complete\n')
      await waitFor(
        () =>
          collected.some(
            (event) => event.t === 'turn' && event.ev.ev === 'completed',
          ),
        'the in-flight codex turn to complete on the adopted handle',
        30_000,
      )
      expect(await adoptedCodex.state().then((state) => state.phase)).toBe('idle')

      // OPENCODE: same server, same port and secret, same pid.
      const opencodeHost = createOpencodeHost({ resources: noResources, durable })
      const opencodeRuntime = createOpencodeRuntime(opencodeHost)
      const adoptedOpencode = await opencodeRuntime.driver.adopt(opencodeBinding)
      expect(adoptedOpencode.binding.process.pid).toBe(opencodePid)
      expect(incarnations('opencode')).toEqual([String(opencodePid)])

      // GROK: the stdio channel re-attaches to the survivor; session/load
      // answers over the new pipes.
      const grokHost = createGrokAcpHost({ resources: noResources, durable })
      const grokRuntime = createGrokAcpRuntime(grokHost)
      const adoptedGrok = await grokRuntime.driver.adopt(grokBinding)
      expect(adoptedGrok.binding.process.pid).toBe(grokPid)
      expect(incarnations('grok')).toEqual([String(grokPid)])

      // Cleanup owns every engine by label, whatever generation holds it now.
      const killer = createDurableProcess('host', { host: true, abduco: false })
      await killer.kill(codexScopeLabel(codexBinding.sessionId))
      await killer.kill(opencodeScopeLabel(opencodeBinding.sessionId))
      await killer.kill(grokAcpProcessKey(grokBinding.sessionId))
      codexRuntime.dispose()
      opencodeRuntime.dispose()
      grokRuntime.dispose()
    } finally {
      try {
        gen1?.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      closeSync(errFd)
    }
  }, 240_000)
})
