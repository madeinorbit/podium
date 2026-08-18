import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildResolvedInventory } from '../packages/harness/src/inventory/build-inventory'
import { createCommandEnvironment } from '../packages/runtime/src/command-environment'

const execFileAsync = promisify(execFile)
const expectedRoot = process.argv[2] ?? '/opt/podium-harness-bin'
const environment = await createCommandEnvironment()
if (environment.source !== 'login-shell') {
  throw new Error(`expected login-shell environment, got ${environment.source}: ${environment.failure ?? 'no failure'}`)
}
if (environment.pathEntries[0] !== expectedRoot) {
  throw new Error(`login-shell PATH did not win: ${environment.pathEntries.join(':')}`)
}
const snapshot = await buildResolvedInventory({
  commandEnvironment: environment,
  machineHome: environment.machineHome,
  credentialHome: environment.machineHome,
})
const expected = {
  'claude-code': 'claude',
  codex: 'codex',
  grok: 'grok',
  opencode: 'opencode',
  cursor: 'agent',
} as const
const launched: Record<string, string> = {}
for (const [kind, name] of Object.entries(expected)) {
  const executable = snapshot.executables.get(kind as keyof typeof expected)
  const path = `${expectedRoot}/${name}`
  if (executable?.path !== path) {
    throw new Error(`${kind}: expected ${path}, got ${executable?.path ?? 'unresolved'}`)
  }
  const { stdout } = await execFileAsync(executable.path, ['--podium-probe'], {
    env: environment.env,
    timeout: 5_000,
  })
  if (!stdout.includes(`${name}:`) || !stdout.includes(expectedRoot)) {
    throw new Error(`${kind}: launch did not inherit recovered PATH: ${stdout}`)
  }
  launched[kind] = executable.path
}
console.log(
  JSON.stringify({
    ok: true,
    shell: environment.loginShell,
    source: environment.source,
    generation: environment.generation,
    pathHead: environment.pathEntries.slice(0, 4),
    launched,
  }),
)
