/** Plain-service launcher + real signed swap + executable that exits before main.
 * Two concurrent, isolated machines prove recovery never crosses state/install roots. */
import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launcherShim } from './build-bun'
import { readPendingGrant } from '@podium/runtime/update-pending'
import type { UpdateStatusMessage } from '@podium/protocol'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

describe('legacy daemon crash recovery', () => {
  it('restores the retained bundle after three boot exits and delivers a durable stuck report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-legacy-rollback-'))
    const key = generateKeyPairSync('ed25519')
    const pubkey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const reports = new Map<string, UpdateStatusMessage>()
    let archive: Uint8Array
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/artifact') return new Response(new Uint8Array(archive))
        if (url.pathname === '/hello') return Response.json({ acknowledged: true })
        if (url.pathname === '/report') {
          reports.set(
            url.searchParams.get('machine')!,
            (await request.json()) as UpdateStatusMessage,
          )
          return new Response('ok')
        }
        return new Response('missing', { status: 404 })
      },
    })
    const children: ReturnType<typeof Bun.spawn>[] = []
    try {
      const entry = join(root, 'entry.ts')
      // The healthy fixture uses production CLI guard dispatch, grant application,
      // installer, durable health/report constructor, and the actual shipped shim.
      // Its tiny acknowledged transport keeps the test independent of auth fixtures.
      writeFileSync(
        entry,
        `
import { main } from ${JSON.stringify(join(ROOT, 'apps/cli/src/cli.ts'))};
import { applyGrant } from ${JSON.stringify(join(ROOT, 'packages/runtime/src/update-participant.ts'))};
import { fetchArtifact } from ${JSON.stringify(join(ROOT, 'packages/runtime/src/update-delivery.ts'))};
import { swapHeadlessBundle } from ${JSON.stringify(join(ROOT, 'packages/runtime/src/update-install.ts'))};
import { readPendingGrant, writePendingGrant } from ${JSON.stringify(join(ROOT, 'packages/runtime/src/update-pending.ts'))};
import { legacyUpdateStatus } from ${JSON.stringify(join(ROOT, 'packages/runtime/src/legacy-daemon-update.ts'))};
import { join } from 'node:path';
if (process.env.PODIUM_LEGACY_DAEMON_GUARD === 'guard') {
  await main(async () => { throw new Error('guard must not load host modules') });
} else {
  const runtime = join(process.env.PODIUM_STATE_DIR!, 'runtime');
  const endpoint = process.env.TEST_ENDPOINT!;
  const hello = await (await fetch(endpoint + '/hello')).json();
  if (!hello.acknowledged) throw new Error('not acknowledged');
  if (readPendingGrant(runtime)) {
    const status = legacyUpdateStatus(runtime, '1.0.0');
    if (!status) throw new Error('rollback report absent');
    await fetch(endpoint + '/report?machine=' + process.env.PODIUM_INSTANCE, { method: 'POST', body: JSON.stringify(status) });
  } else {
    const grant = JSON.parse(process.env.TEST_GRANT!);
    await applyGrant(grant, {
      currentVersion: () => '1.0.0', caps: ['update.delivery.feed'], platform: 'linux-x86_64', legacyHealthGate: true,
      fetchArtifact: (asset, trust) => fetchArtifact(asset, { fetch, pubkey: process.env.TEST_PUBKEY!, trust }),
      swap: bytes => swapHeadlessBundle(bytes, process.env.PODIUM_HOME!),
      writePending: pending => writePendingGrant(runtime, pending),
      restart: () => process.exit(0), report: () => {}, now: Date.now,
    });
    throw new Error('grant did not restart');
  }
}
`,
      )
      const built = await Bun.build({
        entrypoints: [entry],
        target: 'bun',
        conditions: ['@podium/source'],
        outdir: root,
        naming: 'fixture.js',
      })
      if (!built.success) throw new Error(built.logs.map(String).join('\n'))
      const staged = join(root, 'staged')
      const bad = join(staged, 'headless')
      mkdirSync(bad, { recursive: true })
      writeFileSync(join(bad, 'VERSION'), '2.0.0\n')
      writeFileSync(join(bad, 'podium'), launcherShim(), { mode: 0o755 })
      writeFileSync(
        join(bad, 'podium-cli'),
        '#!/bin/sh\necho boot >> "$PODIUM_STATE_DIR/failed-boots"\necho "candidate boot failure" >&2\nexit 42\n',
        { mode: 0o755 },
      )
      execFileSync('tar', ['-czf', join(root, 'bad.tar.gz'), '-C', staged, 'headless'])
      archive = readFileSync(join(root, 'bad.tar.gz'))
      const grant = {
        type: 'updateGrant',
        grantId: 'legacy-crash',
        target: {
          version: '2.0.0',
          critical: false,
          artifacts: {
            headless: {
              delivery: 'feed',
              platforms: {
                'linux-x86_64': {
                  url: `http://127.0.0.1:${server.port}/artifact`,
                  signature: sign(null, archive, key.privateKey).toString('base64'),
                  digest: 'sha256-' + createHash('sha256').update(archive).digest('base64'),
                },
              },
            },
          },
        },
      }
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !name.startsWith('PODIUM_') &&
            !['NOTIFY_SOCKET', 'WATCHDOG_USEC', 'INVOCATION_ID', 'ABDUCO_SOCKET_DIR'].includes(
              name,
            ),
        ),
      )
      const machines = ['blue', 'green'].map((name) => {
        const install = join(root, name, 'install')
        const state = join(root, name, 'state')
        mkdirSync(install, { recursive: true })
        writeFileSync(join(install, 'VERSION'), '1.0.0\n')
        writeFileSync(join(install, 'fixture.js'), readFileSync(join(root, 'fixture.js')))
        writeFileSync(join(install, 'podium'), launcherShim(), { mode: 0o755 })
        writeFileSync(
          join(install, 'podium-cli'),
          `#!/bin/sh\nexec ${shell(process.execPath)} "$(dirname "$0")/fixture.js" "$@"\n`,
          { mode: 0o755 },
        )
        const child = Bun.spawn([join(install, 'podium'), 'daemon'], {
          cwd: root,
          env: {
            ...env,
            PODIUM_INSTANCE: name,
            PODIUM_STATE_DIR: state,
            PODIUM_NO_RELAY: '1',
            TEST_ENDPOINT: `http://127.0.0.1:${server.port}`,
            TEST_GRANT: JSON.stringify(grant),
            TEST_PUBKEY: pubkey,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        children.push(child)
        return { name, install, state, child }
      })
      const timeout = setTimeout(() => {
        for (const child of children) child.kill('SIGKILL')
      }, 30_000)
      try {
        for (const machine of machines) {
          const [code, stderr] = await Promise.all([
            machine.child.exited,
            new Response(machine.child.stderr).text(),
            new Response(machine.child.stdout).text(),
          ])
          expect(code, stderr).toBe(0)
          expect(readFileSync(join(machine.install, 'VERSION'), 'utf8').trim()).toBe('1.0.0')
          expect(
            readFileSync(join(machine.state, 'failed-boots'), 'utf8').trim().split('\n'),
          ).toHaveLength(3)
          const pending = readPendingGrant(join(machine.state, 'runtime'))!
          expect(pending.legacyHealth).toMatchObject({ boots: 3, restored: true })
          expect(reports.get(machine.name)).toMatchObject({
            state: 'stuck',
            version: '1.0.0',
            targetVersion: '2.0.0',
            detail:
              'rolled back from 2.0.0: exited before server acknowledgement (exit 42): candidate boot failure',
          })
        }
      } finally {
        clearTimeout(timeout)
      }
    } finally {
      for (const child of children) {
        child.kill('SIGKILL')
        await child.exited
      }
      server.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
