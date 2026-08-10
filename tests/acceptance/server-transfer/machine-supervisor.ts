import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

type Role = 'source' | 'target'

interface ProcessEvidence {
  role: Role
  supervisorPid: number
  primaryPid: number | null
  primaryExited: boolean
  config: Record<string, unknown> | null
  connectivity: Record<string, unknown> | null
  sourceJournal: Record<string, unknown> | null
  transferStages: Array<Record<string, unknown>>
  machineId: string | null
  health: boolean
  sentinels: {
    artifact: boolean
    transcript: boolean
    agentAfterTransfer: boolean
  }
  processes: string[]
  recordedAt: string
}

const role = process.argv[2] as Role | undefined
if (role !== 'source' && role !== 'target')
  throw new Error('usage: machine-supervisor.ts source|target')

const stateRoot = process.env.PODIUM_STATE_DIR
if (!stateRoot || stateRoot === '/' || stateRoot.includes('.podium')) {
  throw new Error(`refusing unsafe acceptance state root: ${stateRoot ?? '(missing)'}`)
}

const coordRoot = '/coord'
const repoRoot = '/fixture-repo'
mkdirSync(stateRoot, { recursive: true })
mkdirSync(process.env.PODIUM_AGENT_HOME ?? '/agent-home', { recursive: true })
mkdirSync(coordRoot, { recursive: true })
mkdirSync(repoRoot, { recursive: true })
mkdirSync('/fixture-web', { recursive: true })
if (!existsSync(join(repoRoot, '.git'))) {
  const init = Bun.spawnSync(['git', 'init', '-q', repoRoot])
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`)
  writeFileSync(join(repoRoot, 'README.md'), 'disposable server-transfer fixture\n')
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function transferStages(): Array<Record<string, unknown>> {
  const root = join(stateRoot, '.server-transfer')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
      .map((entry) => readJson(join(root, entry.name, 'state.json')))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
  } catch {
    return []
  }
}

function processLines(): string[] {
  const result = Bun.spawnSync(['ps', '-eo', 'pid=,args='])
  if (result.exitCode !== 0) return []
  return result.stdout
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.includes('scripts/cli.ts') ||
        line.includes('machine-supervisor.ts') ||
        line.includes('/usr/bin/abduco'),
    )
}

let primary: ReturnType<typeof Bun.spawn> | undefined
let primaryExited = false

async function writeEvidence(): Promise<void> {
  let health = false
  try {
    const response = await fetch('http://127.0.0.1:18787/health')
    health = response.ok && (await response.text()) === 'ok'
  } catch {
    health = false
  }
  const evidence: ProcessEvidence = {
    role,
    supervisorPid: process.pid,
    primaryPid: primary?.pid ?? null,
    primaryExited,
    config: readJson(join(stateRoot, 'config.json')),
    connectivity: readJson(join(stateRoot, 'connectivity.json')),
    sourceJournal: readJson(join(stateRoot, '.server-transfer', 'journal.json')),
    transferStages: transferStages(),
    machineId: existsSync(join(stateRoot, 'machine.id'))
      ? readFileSync(join(stateRoot, 'machine.id'), 'utf8').trim()
      : null,
    health,
    sentinels: {
      artifact: existsSync(join(stateRoot, 'artifacts', 'docker-transfer.txt')),
      transcript: existsSync(join(stateRoot, 'transcripts', 'docker-transfer.txt')),
      agentAfterTransfer: existsSync(join(stateRoot, 'agent-after-transfer.txt')),
    },
    processes: processLines(),
    recordedAt: new Date().toISOString(),
  }
  const path = join(coordRoot, `${role}-evidence.json`)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(evidence, null, 2)}\n`)
  renameSync(temp, path)
}

async function waitForPairCode(): Promise<string> {
  const path = join(coordRoot, 'pair-code')
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const code = readFileSync(path, 'utf8').trim()
      if (code) return code
    }
    await Bun.sleep(50)
  }
  throw new Error('target timed out waiting for the source pairing code')
}

const evidenceTimer = setInterval(() => void writeEvidence(), 100)
evidenceTimer.unref()
await writeEvidence()

const cli = join('/workspace', 'scripts', 'cli.ts')
const args =
  role === 'source'
    ? [process.execPath, '--conditions=@podium/source', cli, 'all']
    : [
        process.execPath,
        '--conditions=@podium/source',
        cli,
        'daemon',
        '--server',
        'ws://control-proxy:18789',
        '--pair',
        await waitForPairCode(),
        '--name',
        'transfer-target',
      ]

primary = Bun.spawn(args, {
  cwd: repoRoot,
  env: process.env,
  stdin: 'ignore',
  stdout: 'inherit',
  stderr: 'inherit',
})

const terminate = (): void => {
  clearInterval(evidenceTimer)
  try {
    primary?.kill('SIGTERM')
  } catch {
    // Compose teardown can race a process that already handed its role over.
  }
  process.exit(0)
}
process.on('SIGINT', terminate)
process.on('SIGTERM', terminate)

const exitCode = await primary.exited
primaryExited = true
await writeEvidence()
console.log(`[transfer-fixture:${role}] primary exited ${exitCode}; supervisor retaining container`)
await new Promise(() => {})
