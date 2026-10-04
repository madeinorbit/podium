/** Local-only historical checkouts. No global runtime or shared installs are changed. */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root = process.cwd()
const lab = resolve(process.env.IDLE_CPU_LAB ?? '/tmp/podium-idle-cpu-5504')
function run(command, args, cwd = root, env = process.env) {
  const p = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (p.status !== 0) throw new Error(`${command} exited ${p.status}`)
}
mkdirSync(lab, { recursive: true, mode: 0o700 })
const pinned = spawnSync('mise', ['which', 'bun'], { encoding: 'utf8' })
if (pinned.status !== 0) throw new Error('Pinned Bun unavailable')
const toolchain = join(lab, '.toolchain')
mkdirSync(join(toolchain, 'bin'), { recursive: true })
if (!existsSync(join(toolchain, 'bin/bun'))) cpSync(pinned.stdout.trim(), join(toolchain, 'bin/bun'))
const builds = { new: '44809b1850', previous: '1082520' }
for (const [label, sha] of Object.entries(builds)) {
  const checkout = join(lab, label)
  if (!existsSync(join(checkout, '.git'))) run('git', ['worktree', 'add', '--detach', checkout, sha])
  if (!existsSync(join(checkout, '.toolchain'))) cpSync(toolchain, join(checkout, '.toolchain'), { recursive: true })
  const env = { ...process.env, PATH: `${checkout}/.toolchain/bin:${process.env.PATH}` }
  run('bun', ['--version'], checkout, env)
  run('bun', ['run', 'setup:worktree'], checkout, env)
}
writeFileSync(join(lab, 'builds.json'), JSON.stringify(builds, null, 2))
console.log('Historical checkouts and separate dependency graphs prepared')
