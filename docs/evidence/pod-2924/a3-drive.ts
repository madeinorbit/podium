import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import {
  Chat,
  login,
  mutate,
  primeTerminalTui,
  query,
  wait,
} from '../pod-2777/rig.ts'

type Item = { role?: string; text?: string; event?: string; [key: string]: unknown }

const BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2924-a3'
const PORT = process.env.PODIUM_PORT ?? '29241'
const ROOT = process.cwd()
const SOURCE_ROOT = process.env.P2924_SOURCE_ROOT ?? ROOT
const ARM = process.env.P2924_ARM ?? 'parent'
const READINGS = join(ROOT, 'docs/evidence/pod-2924/readings')
const PINS = join(ROOT, 'docs/evidence/pod-2924/pins')
const cwd = join(BASE, 'probes', `claude-a3-${ARM}`)
const textOf = (value: unknown) => typeof value === 'string' ? value : String(value ?? '')
const short = (value: unknown, max = 300) => String(JSON.stringify(value) ?? '').slice(0, max)

function command(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

function output(commandName: string, args: string[]): string {
  const result = command(commandName, args)
  if (!result.ok) throw new Error(`${commandName} ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function processInfo(path: string) {
  const pid = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
  let alive = false
  try {
    if (pid) {
      process.kill(Number(pid), 0)
      alive = true
    }
  } catch {
    // A dead process is recorded and rejected by the pin below.
  }
  const processCwd = pid ? command('readlink', [`/proc/${pid}/cwd`]).stdout : ''
  const environ = pid && existsSync(`/proc/${pid}/environ`)
    ? readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
    : []
  const webDir = environ.find((entry) => entry.startsWith('PODIUM_WEB_DIR='))?.slice('PODIUM_WEB_DIR='.length) ?? ''
  return { pid, alive, cwd: processCwd, webDir }
}

function memoryInfo(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const match = line.match(/^(MemTotal|MemAvailable|SwapFree):\s+(\d+)\s+(\w+)/)
    if (match) result[match[1]] = `${match[2]} ${match[3]}`
  }
  return result
}

async function pin(): Promise<Record<string, unknown>> {
  const checkoutSha = output('git', ['-C', SOURCE_ROOT, 'rev-parse', 'HEAD'])
  const server = processInfo(join(BASE, 'server.pid'))
  const daemon = processInfo(join(BASE, 'daemon.pid'))
  const serverSha = existsSync(join(BASE, 'server.sha')) ? readFileSync(join(BASE, 'server.sha'), 'utf8').trim() : ''
  const daemonSha = existsSync(join(BASE, 'daemon.sha')) ? readFileSync(join(BASE, 'daemon.sha'), 'utf8').trim() : ''
  let web: Record<string, unknown> | { error: string }
  try {
    web = await (await fetch(`http://127.0.0.1:${PORT}/podium-build.json`)).json() as Record<string, unknown>
  } catch (error) {
    web = { error: String(error) }
  }

  const webSourceSha = typeof web === 'object' && 'sourceSha' in web ? textOf(web.sourceSha) : ''
  const resolvedWebSource = webSourceSha
    ? command('git', ['-C', SOURCE_ROOT, 'rev-parse', `${webSourceSha}^{commit}`])
    : { ok: false, stdout: '', stderr: 'missing sourceSha' }
  const webSourceFullSha = resolvedWebSource.ok ? resolvedWebSource.stdout : ''
  const builtAppsWebTree = webSourceFullSha
    ? command('git', ['-C', SOURCE_ROOT, 'rev-parse', `${webSourceFullSha}:apps/web`]).stdout
    : ''
  const runtimeAppsWebTree = command('git', ['-C', SOURCE_ROOT, 'rev-parse', `${checkoutSha}:apps/web`]).stdout
  const appsWebByteIdentical = Boolean(builtAppsWebTree) && builtAppsWebTree === runtimeAppsWebTree
  const servedStampPath = server.webDir ? join(server.webDir, 'podium-build.json') : ''
  const servedStamp = servedStampPath && existsSync(servedStampPath)
    ? JSON.parse(readFileSync(servedStampPath, 'utf8')) as Record<string, unknown>
    : undefined
  const servedStampMatchesResponse = Boolean(servedStamp) && JSON.stringify(servedStamp) === JSON.stringify(web)

  const forbiddenOverrides: Record<string, string | null> = {}
  for (const key of ['PODIUM_STATE_DIR', 'PODIUM_AGENT_HOME', 'ABDUCO_SOCKET_DIR', 'TMUX_TMPDIR', 'PODIUM_WEB_DIR']) {
    forbiddenOverrides[key] = process.env[key] ?? null
  }
  const record = {
    cell: 'A3',
    arm: ARM,
    at: new Date().toISOString(),
    instance: process.env.PODIUM_INSTANCE ?? 'p2924a3',
    sourceRoot: SOURCE_ROOT,
    checkoutSha,
    serverSha,
    daemonSha,
    web,
    webReuseProof: {
      actualBuiltSourceSha: webSourceSha,
      actualBuiltSourceFullSha: webSourceFullSha,
      builtAppsWebTree,
      runtimeAppsWebTree,
      appsWebByteIdentical,
      servedWebDir: server.webDir,
      servedStampPath,
      servedStampMatchesResponse,
    },
    serverPid: server.pid,
    daemonPid: daemon.pid,
    serverAlive: server.alive,
    daemonAlive: daemon.alive,
    serverCwd: server.cwd,
    daemonCwd: daemon.cwd,
    freeMemory: memoryInfo(),
    forbiddenOverrides,
  }
  mkdirSync(PINS, { recursive: true })
  writeFileSync(join(PINS, `${ARM}-a3.json`), JSON.stringify(record, null, 2) + '\n')

  const overrides = Object.entries(forbiddenOverrides).filter(([, value]) => value !== null)
  if (
    checkoutSha.length !== 40 ||
    serverSha !== checkoutSha ||
    daemonSha !== checkoutSha ||
    !server.alive ||
    !daemon.alive ||
    !webSourceFullSha ||
    !appsWebByteIdentical ||
    !servedStampMatchesResponse ||
    overrides.length > 0
  ) {
    throw new Error('pin mismatch ' + short({
      checkoutSha,
      serverSha,
      daemonSha,
      server,
      daemon,
      webSourceSha,
      webSourceFullSha,
      builtAppsWebTree,
      runtimeAppsWebTree,
      appsWebByteIdentical,
      servedStampMatchesResponse,
      overrides,
    }, 1_500))
  }
  return record
}

async function status(sid: string) {
  return (await query('sessions.status', { ref: sid })).result?.data as Record<string, unknown> | undefined
}

async function transcript(sid: string): Promise<Item[]> {
  return (((await query('sessions.read', { sessionId: sid, turns: 500 })).result?.data as { items?: Item[] } | undefined)?.items ?? []) as Item[]
}

async function waitNeedle(sid: string, chat: Chat, needle: string, role: 'user' | 'assistant', timeout: number) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const items = await transcript(sid)
    const serverText = items.filter((item) => item.role === role).map((item) => textOf(item.text)).join('\n')
    const chatText = role === 'user' ? chat.userText() : chat.assistantText()
    if (serverText.includes(needle) || chatText.includes(needle)) {
      return { ok: true, ms: Date.now() - started, items }
    }
    await wait(500)
  }
  return { ok: false, ms: Date.now() - started, items: await transcript(sid) }
}

function visibleCounts(screen: string): number[] {
  const plain = screen.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
  const lineCounts = [...plain.matchAll(/This\s*is\s*line\s*(\d{1,3})/gi)].map((match) => Number(match[1]))
  if (lineCounts.length) return lineCounts
  if (!/I\s*'?ll\s*count\s*from\s*1\s*to\s*220/i.test(plain)) return []
  return [...plain.matchAll(/(?:^|[^\d])(\d{1,3})\.\s*[A-Za-z]/gm)].map((match) => Number(match[1]))
}

async function waitForInFlight(chat: Chat, timeout = 90_000): Promise<Record<string, unknown>> {
  const started = Date.now()
  const initialBytes = chat.screenBytes
  let previousBytes = initialBytes
  let consecutiveGrowth = 0
  let maxVisibleCount = 0
  const samples: Record<string, unknown>[] = []
  while (Date.now() - started < timeout) {
    await wait(1_000)
    const bytes = chat.screenBytes
    const delta = bytes - previousBytes
    previousBytes = bytes
    consecutiveGrowth = delta > 0 ? consecutiveGrowth + 1 : 0
    const counts = visibleCounts(chat.screenTail(12_000))
    maxVisibleCount = Math.max(maxVisibleCount, ...counts, 0)
    samples.push({ ms: Date.now() - started, bytes, delta, visibleCounts: counts.slice(-10), maxVisibleCount })
    if (consecutiveGrowth >= 2 && maxVisibleCount > 0) {
      return { ok: true, initialBytes, bytes, maxVisibleCount, screenTail: chat.screenTail(12_000), samples }
    }
  }
  return { ok: false, initialBytes, bytes: chat.screenBytes, maxVisibleCount, screenTail: chat.screenTail(12_000), samples }
}

async function main(): Promise<void> {
  mkdirSync(READINGS, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const at = new Date().toISOString()
  const load1m = loadavg()[0]
  let sid = ''
  let chat: Chat | undefined
  let pinRecord: Record<string, unknown> | undefined
  let reading: Record<string, unknown>
  try {
    pinRecord = await pin()
    if (load1m >= 12) {
      reading = {
        cell: 'A3', arm: ARM, harness: 'claude', cwd, at, verdict: 'UNDRIVEN',
        summary: 'load gate was not below 12; interrupt was not attempted',
        control: { fired: false, what: 'one-minute load below 12', detail: load1m.toFixed(2) },
        evidence: [`LOAD 1M          ${load1m.toFixed(2)}`, 'DRIVE             UNDRIVEN'],
        data: { load1m, threshold: 12 }, pin: pinRecord,
      }
    } else {
      const made = await mutate('sessions.create', { cwd, agentKind: 'claude-code' })
      sid = (made.result?.data as { sessionId?: string } | undefined)?.sessionId ?? ''
      if (!sid) throw new Error('sessions.create failed ' + short(made))
      chat = new Chat(sid)
      await chat.open()
      await wait(30_000)
      const cleared = await primeTerminalTui(chat, sid)
      const needle = `P2924-A3-${ARM.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`
      const sent = await mutate('sessions.sendText', {
        sessionId: sid,
        text: `Count from 1 to 220, one sentence per line, without tools. Include ${needle} in the final line.`,
      })
      const user = await waitNeedle(sid, chat, needle, 'user', 30_000)
      const running = user.ok ? await waitForInFlight(chat) : { ok: false, screenTail: chat.screenTail(12_000), samples: [] }
      const control = {
        fired: user.ok && running.ok,
        what: 'durable user control plus sustained PTY growth and visible count response',
        detail: `user=${user.ok}; inFlight=${running.ok}; screenBytes=${chat.screenBytes}`,
      }
      if (!control.fired) {
        reading = {
          cell: 'A3', arm: ARM, harness: 'claude', cwd, at, verdict: 'BLOCKED',
          summary: 'independent in-flight control did not fire; interrupt was not exercised', control,
          evidence: [
            `LOAD 1M          ${load1m.toFixed(2)}`,
            `CLEARED          ${JSON.stringify(cleared)}`,
            `SEND             ${short(sent.result?.data ?? sent.error ?? null)}`,
            `IN-FLIGHT        ${short(running, 2_200)}`,
            `SCREEN TAIL      ${JSON.stringify(running.screenTail ?? chat.screenTail(12_000))}`,
          ],
          data: { sid, load1m, needle, user, running }, pin: pinRecord,
        }
      } else {
        const beforeBytes = chat.screenBytes
        const beforeCounts = visibleCounts(chat.screenTail(12_000))
        const beforeMaxCount = Math.max(...beforeCounts, 0)
        const response = await mutate('sessions.interrupt', { sessionId: sid })
        const post: Record<string, unknown>[] = []
        let previousBytes = beforeBytes
        for (let i = 0; i < 20; i++) {
          await wait(1_000)
          const bytes = chat.screenBytes
          const counts = visibleCounts(chat.screenTail(12_000))
          post.push({
            ms: (i + 1) * 1_000,
            bytes,
            delta: bytes - previousBytes,
            maxVisibleCount: Math.max(...counts, 0),
            status: await status(sid),
          })
          previousBytes = bytes
        }
        const trailingZeroSamples = [...post].reverse().findIndex((sample) => sample.delta !== 0)
        const zeroTail = trailingZeroSamples === -1 ? post.length : trailingZeroSamples
        const stopped = zeroTail >= 15
        const advancedAfterInterrupt = post.some((sample) => Number(sample.maxVisibleCount) > beforeMaxCount)
        const grewAfterInterrupt = post.filter((sample) => Number(sample.delta) > 0).length
        const items = await transcript(sid)
        const marker = items.some((item) => item.event === 'interrupt' || /interrupt|cancel/i.test(textOf(item.text)))
        const payload = response.result?.data ?? response.error ?? null
        const refusal = Boolean(response.error) || /refus|unsupported|cannot|not available/i.test(JSON.stringify(payload))
        const pass = stopped && (marker || refusal)
        reading = {
          cell: 'A3', arm: ARM, harness: 'claude', cwd, at, verdict: pass ? 'PASS' : 'FAIL',
          summary: pass
            ? (refusal ? 'interrupt was refused with a typed reason' : 'in-flight turn stopped and transcript recorded interrupt')
            : 'interrupt did not satisfy stop and transcript/refusal clauses',
          control,
          evidence: [
            `LOAD 1M          ${load1m.toFixed(2)}`,
            `CLEARED          ${JSON.stringify(cleared)}`,
            `SEND             ${short(sent.result?.data ?? sent.error ?? null)}`,
            `IN-FLIGHT        ${short(running, 2_200)}`,
            `SCREEN TAIL      ${JSON.stringify(running.screenTail ?? chat.screenTail(12_000))}`,
            `BEFORE BYTES     ${beforeBytes}`,
            `BEFORE COUNT     ${beforeMaxCount}`,
            `INTERRUPT        ${short(payload)}`,
            `TURN STOPPED     ${stopped} (${zeroTail} trailing zero-growth samples)`,
            `POST GROWTH      ${grewAfterInterrupt} positive samples; count advanced=${advancedAfterInterrupt}`,
            `TRANSCRIPT MARKER ${marker}`,
            `TYPED REFUSAL    ${refusal}`,
            `POST SAMPLES     ${short(post, 5_000)}`,
            `ITEMS            ${short(items, 2_500)}`,
          ],
          data: {
            sid, load1m, needle, user, running, beforeBytes, beforeMaxCount,
            interrupt: payload, stopped, zeroTail, advancedAfterInterrupt,
            grewAfterInterrupt, marker, refusal, post, items,
          },
          pin: pinRecord,
        }
      }
    }
  } catch (error) {
    reading = {
      cell: 'A3', arm: ARM, harness: 'claude', cwd, at, verdict: 'BLOCKED',
      summary: `cell could not be driven: ${String(error).slice(0, 240)}`,
      control: { fired: false, what: 'complete pinned A3 run', detail: String(error) },
      evidence: [`ERROR            ${String(error)}`], data: { sid }, pin: pinRecord,
    }
  } finally {
    await chat?.close().catch(() => {})
    if (sid) await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
  }
  writeFileSync(join(READINGS, `${ARM}-a3.json`), JSON.stringify(reading, null, 2) + '\n')
  console.log(`claude/A3 ${ARM} ${reading.verdict} — ${reading.summary}`)
  console.log(`control=${short(reading.control)}`)
  for (const line of reading.evidence as string[]) console.log(line)
}

await login()
await main()
