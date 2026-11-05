/** Real Linux WebKit → current admin HTTP → native durable handoff → restart →
 * source companion ACK. Uses a fresh profile and source launcher, not a release
 * payload/update-delivery claim. Run explicitly while holding the native lease. */
import { expect, it } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { asMachineId, firstAdminMemberId } from '@podium/model'
import { noJanitorWorkerForTests } from '../apps/server/src/janitor-host'
import { startServer } from '../apps/server/src/server'
import { hashPassword } from '../packages/runtime/src/auth-store'
import { loadSupervisorState } from '../packages/runtime/src/machine-supervisor'
import { applyLocalSetupDefault } from '../packages/runtime/src/setup'
import { confirmSetupEnrollment } from '../packages/runtime/src/setup-enrollment'

const enabled = process.env.PODIUM_NATIVE_CLIENT_REGISTRATION === '1'
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
async function until(read: () => boolean | Promise<boolean>, label: string, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await read()) return
    await Bun.sleep(100)
  }
  throw new Error(`native registration timed out: ${label}`)
}
async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => {
    output += data
  })
  child.stderr.on('data', (data) => {
    output += data
  })
  const status = await new Promise<number | null>((done, reject) => {
    child.once('error', reject)
    child.once('exit', done)
  })
  if (status !== 0) throw new Error(`${command} exited ${status}: ${output.slice(-6000)}`)
  return output
}

it.skipIf(!enabled)(
  'recovers a retained revoked client through the actual WebKit bridge with one code/restart and unchanged identity',
  async () => {
    if (!process.env.CARGO_TARGET_DIR) throw new Error('dedicated leased native cache required')
    const repo = resolve(import.meta.dirname, '..')
    const root = mkdtempSync(join(tmpdir(), 'podium-native-registration-'))
    const state = join(root, 'client'),
      serverDir = join(root, 'server')
    const previous = process.env.PODIUM_STATE_DIR
    let coordinator: Awaited<ReturnType<typeof startServer>> | undefined
    let ui: ReturnType<typeof Bun.serve> | undefined
    let display: ChildProcess | undefined
    let shell: ChildProcess | undefined
    const logFile = join(root, 'native.log')
    let mints = 0
    const reports: unknown[] = []
    let keep = false
    try {
      mkdirSync(state, { recursive: true })
      process.env.PODIUM_STATE_DIR = serverDir
      applyLocalSetupDefault()
      coordinator = await startServer({ port: 0, janitorWorkerForTests: noJanitorWorkerForTests })
      const admin = await firstAdminMemberId(coordinator.registry.sessionStore)
      await coordinator.registry.sessionStore.users.setPasswordHash(
        admin,
        await hashPassword('native-scratch-admin'),
        new Date().toISOString(),
      )
      const local = loadSupervisorState(serverDir).setupEnrollment!
      confirmSetupEnrollment(local.requestId, local.publicKey, serverDir)
      const backend = `http://127.0.0.1:${coordinator.port}`
      const serverUrl = `ws://127.0.0.1:${coordinator.port}`
      const oldRoot = process.env.PODIUM_LEGACY_020_ROOT
      if (!oldRoot) throw new Error('exact 0.2 source fixture required')
      const produced = await run(
        process.env.PODIUM_LEGACY_020_BUN ?? 'bun',
        [
          '--conditions=@podium/source',
          join(repo, 'scripts/fixtures/legacy-client-state.ts'),
          oldRoot,
          serverUrl,
        ],
        oldRoot,
        {
          ...process.env,
          PODIUM_STATE_DIR: state,
          PODIUM_INSTANCE: 'native-registration-proof',
          PODIUM_ADOPT_STATE: '1',
        },
      )
      const identity = JSON.parse(produced.trim().split('\n').at(-1)!) as {
        machineId: string
        publicKey: string
      }
      const beforeKey = sha(join(state, 'machine.key'))
      // Seed an explicitly unmanaged enrollment, then revoke it. The actual page's
      // current admin login, not a background machine credential, must restore it.
      const code = coordinator.registry.modules.machines.mintPairingCode({
        ownerUserId: admin,
        podiumManaged: false,
      })
      expect(
        await coordinator.registry.modules.machines.authenticateDaemon({
          type: 'pair',
          machineId: asMachineId(identity.machineId),
          publicKey: identity.publicKey,
          code,
          hostname: 'native-retained',
          assignment: { server: false, agentExecution: false },
        }),
      ).toMatchObject({ ok: true })
      await coordinator.registry.modules.machines.revokeMachine(asMachineId(identity.machineId))
      const entry = join(root, 'probe.ts')
      writeFileSync(
        entry,
        `import { ClientRegistration } from ${JSON.stringify(join(repo, 'apps/web/src/app/client-registration.ts'))};
import { createTRPCClient, httpBatchLink } from ${JSON.stringify(Bun.resolveSync('@trpc/client', repo))};
const report = body => fetch('/probe', {method:'POST',body:JSON.stringify(body)});
(async () => {
  const login = await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'native-scratch-admin'})});
  await report({login:login.status,bridge:!!window.__PODIUM_DESKTOP__});
  const api = createTRPCClient({links:[httpBatchLink({url:location.origin+'/trpc'})]});
  const answer = await new ClientRegistration().start(window.__PODIUM_DESKTOP__,api);
  document.body.textContent = answer || 'Registration connected';
  await report({answer,status:await window.__PODIUM_DESKTOP__.clientRegistrationStatus()});
})().catch(error=>{document.body.textContent=String(error);report({error:String(error)});});`,
      )
      const built = await Bun.build({
        entrypoints: [entry],
        target: 'browser',
        plugins: [
          {
            name: 'web-alias',
            setup(build) {
              build.onResolve({ filter: /^@\// }, ({ path }) => ({
                path:
                  join(repo, 'apps/web/src', path.slice(2)) + (path.endsWith('.ts') ? '' : '.ts'),
              }))
            },
          },
        ],
      })
      if (!built.success) throw new Error(built.logs.map(String).join('\n'))
      const script = await built.outputs[0]!.text()
      const active = coordinator
      ui = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === '/probe') {
            reports.push(await request.json())
            return new Response('ok')
          }
          if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/trpc/')) {
            if (url.pathname.includes('machines.pairingCode')) mints++
            const headers = new Headers(request.headers)
            headers.delete('host')
            headers.delete('origin')
            return fetch(backend + url.pathname + url.search, {
              method: request.method,
              headers,
              ...(request.method === 'GET' ? {} : { body: await request.arrayBuffer() }),
              redirect: 'manual',
            })
          }
          return new Response(
            `<!doctype html><title>Client registration probe</title><body>Starting<script type="module">${script}</script>`,
            { headers: { 'content-type': 'text/html' } },
          )
        },
      })
      const configFile = join(state, 'config.json')
      const config = JSON.parse(readFileSync(configFile, 'utf8'))
      writeFileSync(
        configFile,
        JSON.stringify({
          ...config,
          uiUrl: `http://127.0.0.1:${ui.port}`,
          unrelatedPolicy: 'preserve',
        }),
      )
      const frontend = join(root, 'frontend')
      mkdirSync(frontend)
      writeFileSync(
        join(frontend, 'index.html'),
        '<!doctype html><title>Native registration</title>',
      )
      await run(
        'cargo',
        ['build', '--manifest-path', join(repo, 'apps/desktop/src-tauri/Cargo.toml')],
        repo,
        {
          ...process.env,
          CARGO_INCREMENTAL: '0',
          CARGO_BUILD_JOBS: '2',
          CARGO_PROFILE_DEV_DEBUG: '0',
          TAURI_CONFIG: JSON.stringify({
            build: { frontendDist: frontend },
            bundle: { resources: [] },
          }),
        },
      )
      const nativeApp = join(process.env.CARGO_TARGET_DIR, 'debug/Podium')
      const payload = join(root, 'payload')
      mkdirSync(payload)
      writeFileSync(
        join(payload, 'podium'),
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --conditions=@podium/source ${JSON.stringify(join(repo, 'scripts/cli.ts'))} "$@"\n`,
        { mode: 0o755 },
      )
      writeFileSync(join(payload, 'VERSION'), '0.3.0\n')
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !name.startsWith('PODIUM_') &&
            ![
              'DISPLAY',
              'DBUS_SESSION_BUS_ADDRESS',
              'NOTIFY_SOCKET',
              'WATCHDOG_USEC',
              'INVOCATION_ID',
            ].includes(name),
        ),
      )
      for (const name of ['home', 'data', 'cache', 'config', 'runtime'])
        mkdirSync(join(root, name), { mode: 0o700 })
      Object.assign(env, {
        HOME: join(root, 'home'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_RUNTIME_DIR: join(root, 'runtime'),
        PODIUM_STATE_DIR: state,
        PODIUM_INSTANCE: 'native-registration-proof',
        PODIUM_NO_RELAY: '1',
        PODIUM_ADOPT_STATE: '1',
        PODIUM_NO_SCOPE: '1',
        PODIUM_PAYLOAD_HOME: payload,
        PODIUM_DESKTOP_RUNTIME_PROBE: '1',
        WEBKIT_DISABLE_DMABUF_RENDERER: '1',
        WEBKIT_DISABLE_COMPOSITING_MODE: '1',
        LIBGL_ALWAYS_SOFTWARE: '1',
        GDK_BACKEND: 'x11',
        NO_AT_BRIDGE: '1',
      })
      writeFileSync(logFile, '')
      display = spawn(
        process.env.PODIUM_NATIVE_XVFB ?? 'Xvfb',
        [
          '-displayfd',
          '1',
          '-screen',
          '0',
          '1000x700x24',
          ...(process.env.PODIUM_NATIVE_XKB_DIR
            ? ['-xkbdir', process.env.PODIUM_NATIVE_XKB_DIR]
            : []),
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      display.stderr!.on('data', (bytes) => writeFileSync(logFile, bytes, { flag: 'a' }))
      const displayNumber = await new Promise<string>((done, reject) => {
        display!.once('error', reject)
        display!.stdout!.once('data', (value) => done(String(value).trim()))
        display!.once('exit', () => reject(new Error('isolated Xvfb exited')))
      })
      env.DISPLAY = `:${displayNumber}`
      shell = spawn('dbus-run-session', ['--', nativeApp], {
        cwd: repo,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      for (const stream of [shell.stdout, shell.stderr])
        stream!.on('data', (bytes) => writeFileSync(logFile, bytes, { flag: 'a' }))
      await until(
        async () => {
          try {
            return (
              loadSupervisorState(state).registration?.state === 'enrolled' &&
              !JSON.parse(readFileSync(configFile, 'utf8')).pairCode &&
              (await active.registry.sessionStore.machines.getMachine(identity.machineId))
                ?.revokedAt === null
            )
          } catch {
            return false
          }
        },
        'native restart and supervisor acknowledgement',
        60_000,
      )
      await until(
        () => reports.some((report: any) => report.status?.state === 'enrolled'),
        'restarted page observes enrolled',
      )
      expect(mints).toBe(1)
      expect(sha(join(state, 'machine.key'))).toBe(beforeKey)
      expect(loadSupervisorState(state)).toMatchObject({
        machineId: identity.machineId,
        enrolledPublicKey: identity.publicKey,
        assignment: { server: false, agentExecution: false },
      })
      expect(JSON.parse(readFileSync(configFile, 'utf8'))).toMatchObject({
        mode: 'client',
        serverUrl,
        unrelatedPolicy: 'preserve',
      })
      expect(
        (await active.registry.sessionStore.machines.getMachine(identity.machineId))?.podiumManaged,
      ).toBe(false)
      await Bun.sleep(1_000)
      expect(mints).toBe(1)
      const evidence = {
        candidateBootstrapSha256: sha(join(repo, 'apps/desktop/src-tauri/src/bootstrap.rs')),
        nativeSha256: sha(nativeApp),
        machineId: identity.machineId,
        sameKey: true,
        mints,
        reports,
        scope:
          'Linux WebKit native bridge + source companion; no payload-delivery/Mac/Windows claim',
      }
      writeFileSync(
        process.env.PODIUM_NATIVE_REGISTRATION_EVIDENCE ?? join(root, 'evidence.json'),
        JSON.stringify(evidence, null, 2),
      )
    } catch (error) {
      keep = true
      const details = (() => {
        try {
          return readFileSync(logFile, 'utf8')
        } catch {
          return ''
        }
      })()
      if (process.env.PODIUM_NATIVE_REGISTRATION_EVIDENCE)
        writeFileSync(
          process.env.PODIUM_NATIVE_REGISTRATION_EVIDENCE + '.failure.log',
          String(error) + '\n' + details,
        )
      throw new Error(
        `${String(error)}; scratch=${root}; reports=${JSON.stringify(reports)}; log=${logFile}`,
      )
    } finally {
      if (shell?.pid) {
        try {
          process.kill(-shell.pid, 'SIGTERM')
        } catch {}
      }
      if (display?.pid) {
        try {
          process.kill(display.pid, 'SIGTERM')
        } catch {}
      }
      await Bun.sleep(300)
      ui?.stop(true)
      await coordinator?.close()
      if (previous === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = previous
      if (!keep) rmSync(root, { recursive: true, force: true })
    }
  },
  180_000,
)
