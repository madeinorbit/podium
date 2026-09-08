/** Real Linux machine stand-in: production parent/executor/installer and fleet policy. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { asMachineId } from '@podium/model'
import type { UpdateGrantMessage, UpdateStatusMessage, UpdateTarget } from '@podium/protocol'
import { ParentProcess, PARENT_SUCCESSOR_ENV } from '../../packages/runtime/src/parent-process'
import { registerProcess } from '../../packages/runtime/src/run-registry'
import {
  MachineUpdateExecutor,
  readMachineUpdateJournal,
} from '../../packages/runtime/src/machine-update'
import {
  createHeadlessMachineUpdateAdapter,
  installedArtifactDigest,
} from '../../packages/runtime/src/machine-update-headless'
import { NativeMachineUpdateAdapter } from '../../packages/runtime/src/machine-update-native'
import { verifyTarball } from '../../packages/runtime/src/update-delivery'
import { swapHeadlessBundle } from '../../packages/runtime/src/update-install'
import { startMachineUpdateControl } from '../../packages/runtime/src/machine-update-control'
import { createInstalledCoordinatorUpdate } from '../../apps/server/src/modules/updates/installed-restart'
import { openDatabase } from '@podium/runtime/sqlite'
import { backupDatabase, runDrizzleMigrations } from '../../apps/server/src/migrations'
import { DRIZZLE_MIGRATIONS } from '../../apps/server/src/migrations/drizzle-manifest.generated'
import { SnapshotVerifier } from '../../apps/server/src/migrations/snapshot-verifier'
import { OperationEngine, systemOperationClock } from '../../apps/server/src/modules/operations/engine'
import { OperationKindRegistry } from '../../apps/server/src/modules/operations/kinds'
import { syncQueriesOver } from '../../apps/server/src/store/executor/sync-drizzle'
import { OperationStore } from '../../apps/server/src/modules/operations/store'
import { LIFECYCLE_EXCLUSION_GROUP } from '../../apps/server/src/modules/operations/lifecycle'
import { UpdateRecoveryStore } from '../../apps/server/src/modules/updates/recovery-store'
import {
  createUpdateFleetBridge,
  exclusiveUpdateVersion,
  UPDATE_OPERATION_KIND,
  updateOperationKind,
  type UpdateOperationContext,
  type UpdateReality,
} from '../../apps/server/src/modules/updates/operation'
import { UpdatesService } from '../../apps/server/src/modules/updates/service'
import { decideReconciliation } from '../../apps/server/src/modules/updates/reconciler'
import type { WaveMachine } from '../../apps/server/src/modules/updates/wave'

export function socketRequest(
  socketPath: string,
  path: string,
  body?: unknown,
  token = 'fixture-operator',
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}` },
        timeout: 2000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks)}`))
            return
          }
          if (path.startsWith('/artifact/')) {
            resolve(Buffer.concat(chunks))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()))
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('socket timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export async function runMachine(version: string, buildIdentity: string): Promise<void> {
  const state = process.env.PODIUM_STATE_DIR!
  const installDir = process.env.PODIUM_HOME!
  const id = process.env.FIXTURE_MACHINE!
  const coordinatorSocket = process.env.FIXTURE_COORDINATOR_SOCKET!
  const role = process.argv[2] ?? 'parent'
  const roles = (process.env.FIXTURE_ROLES ?? '').split(',').filter(Boolean) as Array<
    'server' | 'daemon'
  >
  const runtimeDir = join(state, 'runtime')
  mkdirSync(runtimeDir, { recursive: true })
  const digest = installedArtifactDigest(installDir)
  const identity = { version, digest, buildIdentity, pid: process.pid, role }
  const event = (type: string, detail: unknown = {}) =>
    appendFileSync(
      join(state, 'events.ndjson'),
      JSON.stringify({ type, ...identity, detail, at: Date.now() }) + '\n',
    )
  event('boot')
  if (role === 'native-helper') {
    const parent = spawn(join(installDir, 'podium'), ['parent'], {
      env: { ...process.env, FIXTURE_NATIVE: '1' },
      stdio: 'inherit',
    })
    process.on('SIGTERM', () => {
      parent.kill('SIGTERM')
      process.exit(0)
    })
    while (true) {
      try {
        const endpoint = JSON.parse(
          readFileSync(join(runtimeDir, 'machine-update-control.json'), 'utf8'),
        )
        const command = await socketRequest(
          endpoint.socketPath,
          '/native/work',
          undefined,
          endpoint.token,
        )
        if (!command) {
          await sleep(50)
          continue
        }
        try {
          if (command.kind === 'prepare') {
            const asset = command.grant.target.artifacts.desktop.platforms['linux-x86_64']
            const bytes = await socketRequest(coordinatorSocket, new URL(asset.url).pathname)
            if (
              !verifyTarball(
                bytes,
                asset.signature,
                readFileSync(join(state, 'update-key'), 'utf8'),
              )
            )
              throw new Error('native stand-in signature verification failed')
            writeFileSync(join(runtimeDir, 'native-update-artifact'), bytes)
          } else if (command.kind === 'activate') {
            const bytes = readFileSync(join(runtimeDir, 'native-update-artifact'))
            await swapHeadlessBundle(bytes, installDir)
            writeFileSync(
              join(installDir, 'ARTIFACT.sha256'),
              `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
            )
            event('native-activated')
          } else if (command.kind === 'restart') {
            parent.kill('SIGTERM')
            await new Promise<void>((resolve) => parent.once('exit', () => resolve()))
            const successor = spawn(join(installDir, 'podium'), ['native-helper'], {
              env: process.env,
              detached: true,
              stdio: 'ignore',
            })
            successor.unref()
            process.exit(0)
          }
          await socketRequest(
            endpoint.socketPath,
            '/native/result',
            { id: command.id },
            endpoint.token,
          )
        } catch (error) {
          await socketRequest(
            endpoint.socketPath,
            '/native/result',
            { id: command.id, error: String(error) },
            endpoint.token,
          )
        }
      } catch {
        await sleep(50)
      }
    }
  }
  if (role !== 'parent') {
    await registerProcess(role as 'server' | 'daemon')
    if (role === 'daemon' && version === '1.0.0' && existsSync(join(state, 'refuse-daemon')))
      process.exit(78)
    const socket =
      role === 'server' && id === 'coordinator' ? coordinatorSocket : join(state, `${role}.sock`)
    rmSync(socket, { force: true })
    let fleet: Record<string, WaveMachine & { seenAt: number; services?: unknown }> = {}
    const queues = new Map<string, UpdateGrantMessage>()
    const policyPath = join(state, 'fleet-policy.json')
    let policy: { published?: UpdateTarget; approved?: UpdateTarget } = existsSync(policyPath)
      ? JSON.parse(readFileSync(policyPath, 'utf8'))
      : {}
    const dbPath = join(state, 'operations.db')
    const db = id === 'coordinator' ? openDatabase(dbPath) : undefined
    if (db) {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    }
    const store = db ? new OperationStore(syncQueriesOver(db)) : undefined
    const verifier = db ? new SnapshotVerifier(dbPath) : undefined
    let engine: OperationEngine | undefined
    let bridge: ReturnType<typeof createUpdateFleetBridge> | undefined
    const updates = new UpdatesService({
      machines: async () =>
        Object.values(fleet).map((machine) => ({
          ...machine,
          online: Date.now() - machine.seenAt < 1500,
        })),
      approvedTarget: async () => policy.approved,
      ...(db ? { recovery: new UpdateRecoveryStore(db) } : {}),
      exclusiveOperationActive: async () =>
        (await engine?.active(LIFECYCLE_EXCLUSION_GROUP)) !== undefined,
      exclusiveOperationVersion: async (channel) =>
        exclusiveUpdateVersion(await engine?.active(LIFECYCLE_EXCLUSION_GROUP), channel),
      onTargetChanged: async () => {
        await bridge?.onTargetChanged()
      },
      send: (machineId, grant) => {
        queues.set(machineId, grant)
        event('grant', { machineId, grant })
      },
      now: Date.now,
      nextGrantId: () => crypto.randomUUID(),
      concurrency: 3,
      fleetChannel: () => 'dev',
    })
    if (policy.published) updates.setTarget('dev', policy.published)
    const context = (): UpdateOperationContext => ({
      updates,
      channel: 'dev',
      appVersion: () => version,
      serverInstallKind: 'installed',
      hostMachineId: 'coordinator',
      onlyMachines: ['coordinator'],
      prepareCoordinatorUpdate: createInstalledCoordinatorUpdate({
        runtimeDir,
        env: { ...process.env, PODIUM_MACHINE_UPDATE_OWNER: 'supervisor' },
      }),
      // A supervisor preparation must supply its exact activation receipt.
      requestCoordinatorRestart: () => {
        throw new Error('Unscoped coordinator restart')
      },
      prepareVerifiedDatabaseSnapshot: async (from, target) => {
        event('snapshot-waiting')
        while (existsSync(join(state, 'hold-snapshot'))) await sleep(50)
        const path = backupDatabase(db!, dbPath, `update-${from}-to-${target}`)
        if (!path) throw new Error('Coordinator database has no snapshotable file')
        verifier!.recordStaged(path, crypto.randomUUID())
        const schema = db!
          .prepare('SELECT name FROM __drizzle_migrations ORDER BY name DESC LIMIT 1')
          .get() as { name: string }
        return verifier!.verify(path, schema.name)
      },
      recordOperationDetails: async (operationId, patch) => {
        await engine!.recordDetails(operationId, patch)
        if (patch.coordinatorSnapshotGrantId)
          event('snapshot-receipt', {
            operationId,
            ...(await store!.get(operationId))!.operation!.details,
          })
      },
      report: (operationId, stepId, patch) => {
        void engine!.recordProgress(operationId, stepId, patch)
      },
      stepActive: (operationId, stepId) => engine!.watching(operationId, stepId),
    })
    if (store) {
      const registry = new OperationKindRegistry()
      registry.register(updateOperationKind())
      engine = new OperationEngine({ store, registry, clock: systemOperationClock })
      bridge = createUpdateFleetBridge({ engine, updates })
    }
    let adopted = false
    const server = createServer(async (req, res) => {
      try {
        const token = req.headers.authorization
        const authorized =
          token === 'Bearer fixture-operator' || token?.startsWith('Bearer machine-')
        if (!authorized) {
          res.writeHead(401).end()
          return
        }
        if (req.url === '/identity') {
          res.end(JSON.stringify(identity))
          return
        }
        if (req.url?.startsWith('/artifact/')) {
          const asset = req.url.slice('/artifact/'.length)
          if (!/^[a-z0-9.-]+$/.test(asset)) throw new Error('bad artifact path')
          const configPath = join(process.env.FIXTURE_ARTIFACTS!, `${asset}.behavior.json`)
          const behavior = existsSync(configPath)
            ? JSON.parse(readFileSync(configPath, 'utf8'))
            : {}
          if (behavior.fail) {
            res.writeHead(503).end('unavailable')
            return
          }
          const bytes = readFileSync(join(process.env.FIXTURE_ARTIFACTS!, asset))
          res.setHeader('Content-Length', bytes.length)
          if (behavior.delay) {
            res.write(bytes.subarray(0, 16))
            await sleep(behavior.delay)
            res.end(bytes.subarray(16))
            return
          }
          res.end(bytes)
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        const body = raw ? JSON.parse(raw) : undefined
        if (req.url === '/heartbeat') {
          if (token !== `Bearer machine-${body.id}`) {
            res.writeHead(401).end()
            return
          }
          const wasOnline = fleet[body.id] && Date.now() - fleet[body.id]!.seenAt < 1500
          fleet[body.id] = {
            id: body.id,
            name: body.id,
            version: body.version,
            state: 'current',
            online: true,
            busy: false,
            seenAt: Date.now(),
            coordinator: body.id === 'coordinator',
            platform: 'linux-x86_64',
            deliveryCaps: ['update.delivery.feed', 'update.trust.instance'],
            presenceSource: 'supervisor',
            services: body.services,
          }
          for (const status of body.statuses ?? []) {
            updates.onStatus(asMachineId(body.id), status)
            event('status', { machineId: body.id, status })
          }
          if (!wasOnline) {
            const machine = (await updates.fleet()).find((candidate) => candidate.id === body.id)
            const verdict = decideReconciliation({
              machine,
              target: policy.published,
              approvedTargetVersion: policy.approved?.version,
              approvedTarget: policy.approved,
              operationActive: engine?.active(LIFECYCLE_EXCLUSION_GROUP) !== undefined,
              attempts: 0,
            })
            event('reconnect-decision', { machineId: body.id, verdict })
            if (verdict.converge)
              updates.authorizeMachine(asMachineId(body.id), {
                initiator: { kind: 'operator-apply' },
                eligibility: 'fixture persisted exact approval reconnect',
              })
          }
          if (engine && body.id === 'coordinator' && !adopted) {
            adopted = true
            await engine.adoptOnBoot(
              async () => ({
                appVersion: version,
                servedWebDigest: undefined,
                machineDirectory: await updates.fleet(),
                now: Date.now(),
              } satisfies UpdateReality),
              context,
            )
          }
          bridge?.onFleetChanged()
          res.end(JSON.stringify({ grant: queues.get(body.id) }))
          queues.delete(body.id)
          return
        }
        if (token !== 'Bearer fixture-operator') {
          res.writeHead(403).end()
          return
        }
        if (req.url === '/publish') {
          policy.published = body
          updates.setTarget('dev', body)
        } else if (req.url === '/approve') {
          if (policy.published?.version !== body.version)
            throw new Error('target changed before approval')
          policy.approved = policy.published
          writeFileSync(policyPath, JSON.stringify(policy))
          for (const machine of body.machines.filter(
            (machine: string) => machine !== 'coordinator',
          ))
            updates.authorizeMachine(asMachineId(machine), {
              initiator: { kind: 'operator-apply' },
              eligibility: 'fixture explicit operator approval',
            })
          if (body.machines.includes('coordinator')) {
            if (!engine) throw new Error('Coordinator operation engine unavailable')
            const started = await engine.start(UPDATE_OPERATION_KIND, context())
            if (!started.started)
              throw new Error(`Coordinator operation refused: ${JSON.stringify(started)}`)
            res.end(JSON.stringify({ operationId: started.operation.id }))
            return
          }
        } else if (req.url === '/fleet') {
          res.end(JSON.stringify({ fleet: await updates.fleet(), policy, identities: fleet }))
          return
        } else {
          res.writeHead(404).end()
          return
        }
        writeFileSync(policyPath, JSON.stringify(policy))
        res.end('{}')
      } catch (error) {
        res.writeHead(409).end(String(error))
      }
    })
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    const stop = () => {
      event('stop')
      engine?.stop()
      verifier?.close()
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 100).unref()
    }
    process.on('SIGTERM', stop)
    // Kernel parent death is observed in the child; no cleanup by a killed parent is assumed.
    const parentPid = process.ppid
    setInterval(() => {
      if (process.ppid !== parentPid) stop()
    }, 100).unref()
    return
  }
  const statuses: UpdateStatusMessage[] = []
  let control: Awaited<ReturnType<typeof startMachineUpdateControl>> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let executor!: MachineUpdateExecutor
  let acceptingGrants = true
  const roleIdentity = (role: string) =>
    socketRequest(
      role === 'server' && id === 'coordinator' ? coordinatorSocket : join(state, `${role}.sock`),
      '/identity',
    ).catch(() => null)
  const parent = new ParentProcess({
    installDir,
    stateDir: state,
    installBinary: join(installDir, 'podium'),
    port: 1,
    children: roles,
    runningIdentity: { version, digest },
    handoverTimeoutMs: 5000,
    env: { ...process.env, PODIUM_APP_VERSION: version, PODIUM_LOGGING_MODE: 'foreground' },
    probeHealth: async () => {
      const server = await roleIdentity('server')
      const daemon = roles.includes('daemon') ? await roleIdentity('daemon') : null
      return {
        serverRunning: !!server,
        serverVersion: server?.version ?? null,
        daemonConnected: daemon?.version === server?.version,
      }
    },
    probeDaemonHealth: async () => {
      const daemon = await roleIdentity('daemon')
      return {
        connected: !!daemon,
        appVersion: daemon?.version ?? null,
        convergedVersion: daemon?.version ?? null,
      }
    },
    claimRole: () => registerProcess('parent', { reclaimExisting: false }).then(() => {}),
    reclaimRole: () => registerProcess('parent', { reclaimExisting: false }).then(() => {}),
    notify: () => {},
    onExit: async () => {
      acceptingGrants = false
      if (timer) clearInterval(timer)
      await control?.close()
    },
  })
  parent.installSignalHandlers()
  if (process.env[PARENT_SUCCESSOR_ENV] !== '1') await registerProcess('parent')
  const adapter = createHeadlessMachineUpdateAdapter({
    installDir,
    runningVersion: version,
    runningDigest: digest,
    caps: ['update.delivery.feed'],
    pinnedPubkey: () => readFileSync(join(state, 'update-key'), 'utf8'),
    readApplied: () => [],
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      // UDS HTTP bytes enter the actual production signature/digest verifier.
      const parsed = new URL(String(url))
      const bytes = await socketRequest(coordinatorSocket, parsed.pathname)
      init?.signal?.throwIfAborted()
      return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } })
    }) as typeof fetch,
    restart: async (grant, prepared) => {
      event('restart', { grantId: grant.grantId, prepared })
      parent.setUpdateMigrationKnowledge(prepared.releaseHadMigrations)
      await parent.handover(grant.target.version)
    },
  })
  const prepare = adapter.prepare
  adapter.prepare = async (...args) => {
    const result = await prepare(...args)
    event('prepared', result)
    if (existsSync(join(state, 'pause-prepared'))) {
      writeFileSync(join(state, 'paused'), 'prepared')
      while (existsSync(join(state, 'pause-prepared'))) {
        args[1].throwIfAborted()
        await sleep(50)
      }
    }
    return result
  }
  const activate = adapter.activate
  adapter.activate = async (...args) => {
    if (existsSync(join(state, 'fail-activation'))) throw new Error('fixture activation failure')
    if (existsSync(join(state, 'pause-activation'))) {
      writeFileSync(join(state, 'paused'), 'activating')
      while (existsSync(join(state, 'pause-activation'))) await sleep(50)
    }
    if (id === 'coordinator') {
      // This is the real supervisor process, before the production adapter swaps bytes.
      // Read another connection: an in-memory flag cannot prove the operation's receipt.
      const db = openDatabase(join(state, 'operations.db'), { readOnly: true })
      try {
        const operation = (await new OperationStore(syncQueriesOver(db)).history(UPDATE_OPERATION_KIND))[0]
          ?.operation
        const details = operation?.details
        const grant = args[0]
        const recovered = new UpdateRecoveryStore(db)
          .read()
          ?.grants.find(([machine]) => machine === id)?.[1].coordinatorGrant
        if (
          !operation ||
          details?.coordinatorSnapshotGrantId !== grant.grantId ||
          typeof details.databaseSnapshotPath !== 'string' ||
          !existsSync(details.databaseSnapshotPath) ||
          !isDeepStrictEqual(recovered, grant) ||
          !isDeepStrictEqual(details.target, grant.target)
        )
          throw new Error('Activation preceded the durable exact operation/snapshot receipt')
        event('activation-receipt', { operationId: operation.id, grant, ...details })
      } finally {
        db.close()
      }
    }
    await activate(...args)
    event('activated', args[1])
  }
  const nativeAdapter =
    process.env.FIXTURE_NATIVE === '1'
      ? new NativeMachineUpdateAdapter({ runtimeDir, version, digest })
      : undefined
  executor = new MachineUpdateExecutor({
    runtimeDir,
    adapter: nativeAdapter ?? adapter,
    report: (status) => {
      statuses.push(status)
      event('progress', status)
    },
    log: (phase, fields) => event(phase, fields),
  })
  await executor.recoverBeforeBoot()
  const journal = executor.snapshot()
  if (
    journal &&
    ['activating', 'restarting'].includes(journal.phase) &&
    (journal.prepared?.digest !== digest || journal.grant.target.version !== version)
  )
    await executor.confirmBoot(true)
  await parent.start()
  control = await startMachineUpdateControl(runtimeDir, executor, nativeAdapter)
  await executor.confirmBoot(parent.isBootHealthy())
  let sending = false
  const heartbeat = async () => {
    if (sending || existsSync(join(state, 'offline'))) return
    sending = true
    const pending = statuses.splice(0)
    try {
      const response = await socketRequest(
        coordinatorSocket,
        '/heartbeat',
        {
          id,
          version,
          digest,
          buildIdentity,
          services: parent.snapshot().children,
          statuses: pending,
        },
        `machine-${id}`,
      )
      if (response.grant)
        await executor
          .accept(response.grant, false, false, {
            kind: 'coordinator',
            // The fixture's authenticated heartbeat replaces the production WS.
            serverUrl: `ws://fixture.invalid/${encodeURIComponent(coordinatorSocket)}`,
            isCurrent: () => acceptingGrants && !existsSync(join(state, 'offline')),
          })
          .catch((error) => {
            statuses.push({
              type: 'updateStatus',
              grantId: response.grant.grantId,
              version,
              state: 'rejected',
              detail: String(error),
            })
          })
    } catch {
      statuses.unshift(...pending)
    } finally {
      sending = false
    }
  }
  timer = setInterval(() => void heartbeat(), 100)
  await heartbeat()
}
