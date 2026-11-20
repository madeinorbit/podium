/**
 * Disposable VPS proof for the explicit install-finish --agents path.
 * Run on a remote Docker lane, after claiming lab:vpsN. Only the named slot is touched.
 * bun run test:managed-install-setup -- --slot N --reset-slot
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const slot = args[args.indexOf('--slot') + 1]
assert(args.includes('--slot') && slot && /^[1-9]\d*$/.test(slot), 'Name the assigned --slot N.')
assert(
  args.includes('--reset-slot'),
  'Pass --reset-slot only after claiming this disposable lab slot.',
)
const box = `vps${slot}`
const lab = 'tools/vps-lab/lab'
function run(command: string[], capture = false): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      `${command[0]} failed (${result.status})${capture ? `: ${result.stdout}${result.stderr}` : ''}`,
    )
  return result.stdout ?? ''
}
run([lab, 'status'])
if (
  spawnSync('docker', ['image', 'inspect', 'podium-vps-lab:base'], { stdio: 'ignore' }).status !== 0
)
  run([lab, 'build'])
run([lab, 'reset', slot])
const linger = run([lab, 'exec', slot, 'cat', '/etc/systemd/system/lab-linger.service'], true)
const user = linger.match(/enable-linger\s+([A-Za-z0-9_.-]+)/)?.[1]
assert(user, 'The lab image must identify its disposable user in lab-linger.service.')
const home = run([lab, 'exec', slot, 'getent', 'passwd', user], true).trim().split(':')[5]
assert(home && home.startsWith('/home/'), 'The lab user must have a separate account home.')
const inside = (command: string[], capture = false) =>
  run(
    [
      'docker',
      'exec',
      '--user',
      user,
      '--env',
      `HOME=${home}`,
      '--env',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      '--workdir',
      '/work',
      box,
      ...command,
    ],
    capture,
  )
const scratch = mkdtempSync(join(tmpdir(), 'managed-setup-lab-'))
try {
  run([lab, 'exec', slot, 'mkdir', '-p', '/work'])
  const tar = join(scratch, 'source.tar')
  run(['git', 'archive', '--format=tar', '--output', tar, 'HEAD'])
  run(['docker', 'cp', tar, `${box}:/tmp/source.tar`])
  run([lab, 'exec', slot, 'tar', '-xf', '/tmp/source.tar', '-C', '/work'])
  run([lab, 'exec', slot, 'chown', '-R', user, '/work'])
  run(['docker', 'cp', realpathSync(process.execPath), `${box}:/usr/local/bin/bun`])
  const snapshotScript = `set -eu
for name in .bashrc .bash_profile .profile .zshrc; do
  if test -f "$1/$name"; then sha256sum "$1/$name"; else printf 'absent %s\\n' "$name"; fi
done
if test -d "$1/.local/bin"; then find "$1/.local/bin" -printf '%y %P %l\\n' | sort; find "$1/.local/bin" -type f -exec sha256sum {} + | sort; else printf 'no personal bin\\n'; fi`
  const before = inside(['bash', '-c', snapshotScript, 'snapshot', home], true)
  inside(['bun', '--version'])
  inside(['bun', 'run', 'setup:worktree'])
  inside([
    'bun',
    '--conditions=@podium/source',
    'scripts/cli.ts',
    'install-finish',
    '--channel',
    'stable',
    '--dest',
    '/work',
    '--bin',
    '/tmp/installer-bin',
    '--command',
    'podium',
    '--agents',
    'claude-code',
    '--no-modify-path',
    '--no-interactive',
  ])
  const verify = `import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultHarnessesDir, InstallLedger } from './packages/harness/src/inventory.ts';
const ledger = InstallLedger.open();
try {
  const row = ledger.get('claude-code');
  assert.equal(row?.requested.by, 'machine-setup');
  assert(row.current !== null);
  const release = ledger.currentRelease('claude-code');
  assert(release?.receipt);
  assert(release.dir.startsWith(defaultHarnessesDir() + '/'));
  assert(existsSync(join(release.dir, release.receipt.executable)));
  console.log(JSON.stringify({ requestedBy: row.requested.by, version: release.receipt.version, releaseUnderStateHarnesses: true }));
} finally { ledger.close(); }`
  const result = inside(['bun', '--conditions=@podium/source', '-e', verify], true).trim()
  const after = inside(['bash', '-c', snapshotScript, 'snapshot', home], true)
  assert.equal(after, before, '--agents changed the personal bin or a shell profile.')
  console.log(
    JSON.stringify({
      slot: Number(slot),
      setup: JSON.parse(result),
      personalBinUnchanged: true,
      shellProfilesUnchanged: true,
      result: 'passed',
    }),
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
