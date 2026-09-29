// Grok ACP driver, live against `grok agent stdio` 1.0.44 (POD-4837). Run from the repo root:
//   P=<scratch with home/.grok/config.toml and work/> LONG=1 bun --conditions=@podium/source docs/measurements/pod-4834-receipt-proof/grok-acp-1.0.44/driver-live-check.ts
// Live check of the grok-acp driver against the real `grok agent stdio` (POD-4837).
import type { SessionId } from '@podium/model'
import { createGrokAcpRuntime } from '../../../../packages/harness/src/driver/families/grok-acp/runtime.ts'
import { createMemoryDriverSlots } from '../../../../packages/harness/src/driver/testing/index.ts'

const P = process.env.P!
const t0 = performance.now()
const now = () => Math.round(performance.now() - t0)
const log = (...a: unknown[]) => console.log(`[${now()}ms]`, ...a)
const entries = new Map<SessionId, any>()
let seq = 0
const host: any = {
  bindings: {
    recorded: (id: SessionId) => entries.get(id),
    bound: (e: any) => entries.set(e.sessionId, e),
    released: (id: SessionId) => entries.delete(id),
  },
  now: () => Date.now(),
  mintSessionId: () => `gk-live-${++seq}` as SessionId,
  async launch() {
    const proc = Bun.spawn(['grok', 'agent', 'stdio'], {
      cwd: `${P}/work`,
      env: { ...process.env, HOME: `${P}/home`, GROK_HOME: `${P}/home/.grok`, FAKE_KEY: 'dummy' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    let handler: any
    ;(async () => {
      const dec = new TextDecoder()
      let buf = ''
      for await (const c of proc.stdout) {
        buf += dec.decode(c)
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const l = buf.slice(0, i)
          buf = buf.slice(i + 1)
          handler?.line(l)
        }
      }
      handler?.closed()
    })()
    return {
      transport: {
        write: (l: string) => {
          proc.stdin.write(l)
          proc.stdin.flush()
        },
        onLine: (h: any) => {
          handler = h
        },
        close: () => proc.stdin.end(),
      },
      process: { key: `live-${seq}`, pid: proc.pid },
      alive: () => proc.exitCode === null,
      stop: async () => {
        proc.kill()
        await proc.exited
      },
      kill: async () => {
        proc.kill(9)
        await proc.exited
      },
      resources: () => undefined,
    }
  },
}
const spec: any = {
  harness: 'grok',
  selection: {
    auth: 'subscription',
    platform: 'linux',
    available: ['grok-acp'],
    preference: 'grok-acp',
  },
  workdir: `${P}/work`,
  model: {},
  instructions: { supported: false, reason: 'live' },
  mcpServers: { supported: false, reason: 'live' },
}
const runtime = createGrokAcpRuntime(host, createMemoryDriverSlots())
const idle = async (h: any) => {
  for (;;) {
    const s = await h.state()
    if (s.phase !== 'working') return s.phase
    await Bun.sleep(50)
  }
}
const send = async (h: any, id: string, text: string) => {
  const at = now()
  const receipt = await h.send(
    { id, text },
    {
      origin: 'human',
      delivery: 'when-ready',
      onTranscriptItem: (item: any) =>
        log(`  ${id}: entry named ${item.id} (+${now() - at} ms after the send)`),
    },
  )
  log(
    `  ${id}: receipt ${receipt.outcome} provenBy=${receipt.provenBy} epoch=${receipt.turnEpoch} item=${receipt.transcriptItem?.id ?? '-'} (+${now() - at} ms)`,
  )
  return receipt
}
const users = async (h: any) =>
  (await h.transcript.history({ limit: 100 })).items
    .filter((i: any) => i.role === 'user')
    .map((i: any) => `${i.id}=${JSON.stringify(i.text)}`)
const h = await runtime.driver.create(spec)
log('created', h.binding.resume)
if (!process.env.ONLY_LONG) {
  await send(h, 'msg_live-hello', 'say hello')
  log('  idle:', await idle(h))
  await send(h, 'msg_live-hello', 'say hello')
  log('  idle:', await idle(h))
}
if (process.env.LONG) {
  await send(h, 'msg_live-long', 'verylong please')
  log('  long turn ended:', await idle(h), JSON.stringify((await h.state()).error ?? null))
}
log('live users:', await users(h))
if (process.env.ONLY_LONG) {
  runtime.dispose()
  process.exit(0)
}
const ref = h.binding.resume
await h.stop()
const r = await runtime.driver.resume(ref, spec)
log('resumed users:', await users(r))
await send(r, 'msg_live-hello', 'say hello')
log('  idle:', await idle(r))
await send(r, 'msg_live-new', 'say bye')
log('  idle:', await idle(r))
log('resumed users after:', await users(r))
await r.stop()
runtime.dispose()
process.exit(0)
