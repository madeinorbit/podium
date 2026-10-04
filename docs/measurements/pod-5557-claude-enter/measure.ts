// A measurement, not a repository test. Uses the production injector and PTY backend.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { bunTerminalBackend } from '../../../packages/pty/src/backends/bun-terminal-backend.ts'
import { createTerminalInjection, SUBMIT_CR_DELAY_MS, type TerminalInjectionPorts } from '../../../packages/harness/src/driver/families/terminal/injection.ts'
import { classifyClaudeScreen } from '../../../packages/harness/src/adapters/claude-code/state.ts'

const { Terminal } = createRequire(new URL('../../../packages/pty/package.json', import.meta.url))('@xterm/headless')
const args = process.argv.slice(2)
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const version = option('--version', '2.1.283')
const binary = option('--binary', version === '2.1.283' ? '/tmp/pod5557-binaries/claude-2.1.283' : `/home/mgw/.local/share/claude/versions/${version}`)
const delays = option('--delays', '0,30,90,200,500').split(',').map(Number)
const states = option('--states', 'idle,streaming,tool,compacting').split(',')
const bodies = option('--bodies', 'short,multiline,long').split(',')
const load = args.includes('--load')
const retries = args.includes('--retries')
const bg = args.includes('--bg')
const stall = Number(option('--stall-ms', '0'))
const repeat = Number(option('--repeat', '1'))
const fault = option('--fault-first-cr', 'none')
const verifyInput = args.includes('--verify-input')
const port = Number(option('--port', '45557'))
const here = import.meta.dir
const label = option('--label', `${version}-${load ? 'load' : 'normal'}${retries ? '-retries' : ''}${stall ? `-stall${stall}` : ''}`)
const output = join(here, `${label}.jsonl`)
const scratch = mkdtempSync(join(tmpdir(), `pod5557-${label}-`))
const work = join(scratch, 'work')
const home = join(scratch, 'home')
const config = join(home, '.claude')
const releaseFile = join(scratch, 'release')
mkdirSync(work, { recursive: true }); mkdirSync(config, { recursive: true })
const fakeKey = 'fake-key-for-the-local-fake-server-not-a-credential'
writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }))
writeFileSync(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
  customApiKeyResponses: { approved: [fakeKey.slice(-20)], rejected: [] },
  cachedGrowthBookFeatures: { tengu_virtual_pancake: true },
  projects: { [work]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } } }))
// WHITELIST: no credentials, live session hooks, or operator config are inherited.
const env = { PATH: process.env.PATH!, HOME: home, SHELL: '/bin/bash', TERM: 'xterm-256color', LANG: 'C.UTF-8',
  CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: fakeKey, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0', DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: '1' }
if (bg) Object.assign(env, { CLAUDE_CODE_SESSION_KIND: 'bg' })
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const fakeLog = join(scratch, 'requests.jsonl')
const control = (body: unknown) => fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', body: JSON.stringify(body) })
const jsonLines = (path: string): any[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').flatMap(line => {
  try { return [JSON.parse(line)] } catch { return [] }
}) : []
function records(): any[] {
  const files: string[] = []
  const visit = (path: string) => {
    if (!existsSync(path)) return
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'subagents') continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.name.endsWith('.jsonl')) files.push(child)
    }
  }
  visit(join(config, 'projects'))
  return files.flatMap(jsonLines)
}
function accepted(id: string, rows = records()): any[] {
  return rows.filter(row => (row.type === 'user' || row.type === 'queue-operation' || row.type === 'attachment') && JSON.stringify(row).includes(id))
}
async function until(predicate: () => unknown | Promise<unknown>, timeout = 20_000) {
  const end = performance.now() + timeout
  while (performance.now() < end) { if (await predicate()) return; await sleep(25) }
  throw new Error(`Timed out: ${scratch}\n${JSON.stringify(screen())}`)
}
const terminal = new Terminal({ cols: 160, rows: 45, allowProposedApi: true, scrollback: 1000 })
let pty: ReturnType<ReturnType<typeof bunTerminalBackend>['spawn']> | undefined
let running = true
let lastOutput = Date.now()
let phase = 'idle'
let writes: any[] = []
let faultArmed = false
let firstEnterEvidence: unknown
const burners: ReturnType<typeof Bun.spawn>[] = []
const flush = () => new Promise<void>(resolve => terminal.write('', resolve))
function screen() {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let index = buffer.baseY; index < buffer.baseY + 45; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
  return { cursor: { x: buffer.cursorX, y: buffer.cursorY }, inputDraft: classifyClaudeScreen(lines).inputDraft, lines }
}
function composer() {
  const snapshot = screen()
  const start = snapshot.lines.findLastIndex(line => /^❯/.test(line.trimStart()))
  return start < 0 ? [] : snapshot.lines.slice(start)
}
function inject(text: string, delay: number, withRetries = false) {
  const abort = new AbortController()
  const cancel = setTimeout(() => abort.abort(), withRetries ? 5500 : 1350 + delay)
  const ports: TerminalInjectionPorts = {
    now: Date.now, running: () => running, live: () => true, phase: () => phase, lastOutputAtMs: () => lastOutput,
    write(bytes, origin) {
      const captureFault = faultArmed && bytes === '\r' && verifyInput
      const delayedPasteEnd = faultArmed && bytes === '\r' && fault === 'inside-paste'
      const actual = faultArmed && bytes.startsWith('\x1b[200~') && fault === 'inside-paste' ? bytes.slice(0, -6)
        : faultArmed && bytes === '\r' && fault === 'lf' ? '\n' : bytes
      if (bytes === '\r') faultArmed = false
      writes.push({ at: Date.now(), mono: performance.now(), bytes: actual, intended: bytes, origin })
      pty!.write(actual)
      if (delayedPasteEnd) setTimeout(() => {
        writes.push({ at: Date.now(), mono: performance.now(), bytes: '\x1b[201~', origin: 'fault-paste-end' })
        pty!.write('\x1b[201~')
      }, 100)
      if (captureFault) setTimeout(async () => {
        await flush()
        firstEnterEvidence = { at: Date.now(), screen: screen(), records: accepted(text.split('\n')[0]) }
      }, 150)
    },
    setTimer(callback, ms) { return setTimeout(callback, ms === SUBMIT_CR_DELAY_MS ? delay : ms) },
    clearTimer(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>) },
    rawFirstTurn: () => false, needsSubmitVerification: () => withRetries, observedTurnEpoch: () => 0,
    ...(verifyInput ? { readInput: async () => { await flush(); return screen().inputDraft }, foreignWriteCount: () => 0 } : {}),
    echoAccept: { watch(body) {
      const baseline = records().length
      let done = false
      let accept!: (seen: {}) => void
      let hold!: () => void
      const recorded = new Promise<{}>(resolve => { accept = resolve })
      const held = new Promise<void>(resolve => { hold = resolve })
      const key = body.split('\n')[0]
      const started = Date.now()
      const poll = setInterval(() => {
        if (done) return
        const found = accepted(key, records().slice(baseline))
        if (found.some(row => row.type === 'user' || row.type === 'attachment')) accept({})
        if (found.some(row => row.type === 'queue-operation' && row.operation === 'enqueue')) hold()
      }, 25)
      return { accepted: recorded, held, typingStartedAtMs: started, cancel() { done = true; clearInterval(poll) } }
    } },
  }
  const machine = createTerminalInjection(ports)
  const promise = machine.deliver(text, { origin: 'human', delivery: 'when-ready', signal: abort.signal }).finally(() => {
    clearTimeout(cancel); machine.dispose()
  })
  return promise
}
let fake: ReturnType<typeof Bun.spawn> | undefined
try {
  // Refuse to interfere with an already-owned port. No inherited server is ever killed.
  const owners = Bun.spawnSync(['fuser', `${port}/tcp`], { stdout: 'pipe', stderr: 'pipe' })
  if (owners.exitCode === 0) throw new Error(`Port ${port} is occupied`)
  fake = Bun.spawn([process.execPath, join(here, 'fake-model-server.ts')], { env: { ...env, FAKE_PORT: String(port), FAKE_LOG: fakeLog, FAKE_RELEASE: releaseFile },
    stdout: Bun.file(join(scratch, 'fake.stdout')), stderr: Bun.file(join(scratch, 'fake.stderr')) })
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false } })
  const cpus = readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)![1].trim()
  const firstCpu = cpus.split(/[,-]/)[0]
  if (load) for (let index = 0; index < 4; index++) burners.push(Bun.spawn(['taskset', '-c', firstCpu, 'python3', '-c', 'while True: pass'], { env, stdout: 'ignore', stderr: 'ignore' }))
  pty = bunTerminalBackend().spawn({ file: load ? '/usr/bin/taskset' : binary,
    args: [...(load ? ['-c', firstCpu, binary] : []), '--model', 'claude-sonnet-4-6'], cwd: work, env, cols: 160, rows: 45 })
  pty.onData(bytes => {
    lastOutput = Date.now()
    appendFileSync(join(scratch, 'terminal.cast'), `${JSON.stringify([performance.now(), Buffer.from(bytes).toString('utf8')])}\n`)
    terminal.write(bytes)
  })
  pty.onExit(() => { running = false })
  terminal.onData((bytes: string) => pty!.write(bytes))
  writeFileSync(join(scratch, 'pids.json'), JSON.stringify({ fake: fake.pid, claude: pty.pid, burners: burners.map(burner => burner.pid), port }))
  console.log(JSON.stringify({ label, scratch, pids: JSON.parse(readFileSync(join(scratch, 'pids.json'), 'utf8')) }))
  await until(() => screen().lines.some(line => line.trimStart().startsWith('❯')))
  await sleep(300)
  writeFileSync(join(scratch, 'screen-start.json'), JSON.stringify(screen()))
  const idle = async () => {
    await until(() => !classifyClaudeScreen(screen().lines).turnRunning)
    await sleep(load ? 500 : 160)
    phase = 'idle'
  }
  for (let index = 0; index < 3; index++) { await inject(`warmup-${index}`, 500); await idle() }
  let number = 0
  for (let iteration = 0; iteration < repeat; iteration++) for (const state of states) for (const kind of bodies) for (const delay of delays) {
    const id = `ENTER-${version}-${load ? 'load' : 'normal'}-${++number}-${state}-${kind}-${delay}`
    const text = kind === 'short' ? `${id} hello` : kind === 'multiline' ? `${id}\nfirst line\nsecond line\nthird line` : `${id}\n${'x'.repeat(1000)}`
    await idle()
    let setupRecords: any[] = []
    if (state !== 'idle') {
      await control({ next: state })
      const setupId = `SETUP-${number}-${state}`
      if (state === 'compacting') {
        // Slash commands intentionally have no prompt record. Same paste and CR path.
        const setupAt = Date.now()
        const setup = inject('/compact', 500)
        await until(() => jsonLines(fakeLog).some(row => row.at >= setupAt && row.mode === 'compacting') && screen().lines.some(line => /Compacting conversation…/.test(line)))
        await setup
      } else {
        await inject(setupId, 500)
        await until(() => state === 'tool' ? /Running|esc to interrupt/i.test(screen().lines.join('\n')) && screen().lines.some(line => line.includes('release'))
          : /esc to interrupt/i.test(screen().lines.join('\n')) && screen().lines.some(line => line.includes('stream')))
        setupRecords = accepted(setupId)
      }
      phase = state === 'compacting' ? 'compacting' : 'working'
    }
    await flush()
    const before = screen()
    writes = []
    firstEnterEvidence = undefined
    const started = Date.now()
    faultArmed = fault !== 'none'
    if (stall) { process.kill(pty.pid, 'SIGSTOP'); setTimeout(() => process.kill(pty!.pid, 'SIGCONT'), stall) }
    const delivery = inject(text, delay, retries)
    await sleep(delay + (retries ? 5000 : 1200))
    await flush()
    const afterCR = screen()
    const afterRecords = accepted(id)
    const receipt = await delivery
    const didSubmit = afterRecords.length > 0
    const beforeRecovery = { at: Date.now(), screen: afterCR, composer: composer(), records: afterRecords, receipt, writes: [...writes] }
    if (!didSubmit && afterCR.inputDraft) {
      await sleep(300)
      writes.push({ at: Date.now(), mono: performance.now(), bytes: '\r', origin: 'recovery' })
      pty.write('\r')
      await sleep(800)
    }
    if (state !== 'idle') { writeFileSync(releaseFile, 'released'); await control({ release: true }) }
    let recordedEventually = true
    try { await until(() => accepted(id).some(row => row.type === 'user' || row.type === 'attachment'), 5000) } catch { recordedEventually = false }
    await idle(); await flush()
    const finalRecords = accepted(id)
    const firstCR = beforeRecovery.writes.find(row => row.intended === '\r')
    const firstPaste = beforeRecovery.writes.find(row => row.bytes !== '\r')
    const row = { case: id, version, state, body: kind, delay, load, stall, retries, bg, fault, verifyInput, iteration, started, text, recordedEventually,
      observedDelay: firstCR && firstPaste ? firstCR.mono - firstPaste.mono : null,
      firstCRSubmitted: didSubmit, before, firstEnterEvidence, beforeRecovery, final: { at: Date.now(), screen: screen(), records: finalRecords, writes }, setupRecords }
    appendFileSync(output, `${JSON.stringify(row)}\n`)
    console.log(JSON.stringify({ case: id, delay, observedDelay: row.observedDelay, submitted: didSubmit,
      recordTypes: afterRecords.map(record => `${record.type}:${record.operation ?? ''}`), cursor: afterCR.cursor }))
    if (!recordedEventually && screen().inputDraft) {
      pty.write('\x15'.repeat(screen().inputDraft!.split('\n').length + 1))
      await sleep(300)
      if (screen().inputDraft) throw new Error('Unable to reset scratch input after a lost case')
    }
  }
} finally {
  // Stop only the PIDs recorded for this run. Fake cleanup is explicitly by PORT.
  if (pty) { try { process.kill(pty.pid, 'SIGCONT') } catch {} pty.kill('SIGTERM') }
  for (const burner of burners) burner.kill('SIGTERM')
  if (fake) {
    const owners = Bun.spawnSync(['fuser', `${port}/tcp`], { stdout: 'pipe', stderr: 'pipe' })
    const ids = Buffer.from(owners.stdout).toString().trim().split(/\s+/).filter(Boolean).map(Number)
    if (ids.length === 1 && ids[0] === fake.pid) Bun.spawnSync(['fuser', '-k', `${port}/tcp`], { stdout: 'pipe', stderr: 'pipe' })
    else fake.kill('SIGTERM')
  }
  terminal.dispose()
  console.log(JSON.stringify({ finished: label, scratch, output }))
}
