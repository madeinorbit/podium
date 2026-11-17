/**
 * The Postgres test server and its template databases [POD-6980, POD-6958 design 2.10].
 *
 * The vitest `globalSetup` of the `server-store-pg` lane (`vitest.store-pg.config.ts`).
 * It runs once per lane, in vitest's main process, before any fork starts, and:
 *
 * 1. Finds the server. CI names its service container in `PODIUM_TEST_PG_URL`.
 *    Anywhere else the server is ONE container per host, `podium-test-pg`, shared by
 *    every worktree: Postgres 17 on Debian (glibc collation, as on PlanetScale), data
 *    on tmpfs, published on loopback only, with a fixed test password. The lane starts
 *    it when it is missing or stopped and leaves it running for the next lane.
 * 2. Builds the template for the current migration chain's digest, if no lane has yet.
 * 3. Sweeps databases left by lanes that died more than {@link STALE_RUN_MS} ago.
 * 4. Hands the forks the server URL, the template and a fresh run id.
 *
 * Steps 1 to 3 run under a HOST LOCK, a file under `~/.cache/podium/<host>/`, so lanes
 * in many worktrees share one container without two of them starting it, or building
 * one template, at once. It is a file and not a `podium lock` for the reason
 * `scripts/validation-admission.ts` gives for its slots: the holder is a process on
 * this host, `kill(pid, 0)` says whether it is alive, and no Podium server has to be up.
 * Once step 4 is reached the lock is released: runs never share a database, so lanes
 * run in parallel against the one server.
 *
 * The teardown drops every database of the run that a fork did not drop itself.
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import postgres from 'postgres'
import type { DrizzleMigration } from '../migrations/index'
import { migratePg, PG_MIGRATIONS } from '../migrations/pg/index'
import {
  copySeedTables,
  PG_EARLIEST_ADMIN_SQL,
  PG_TEST_FIRST_ADMIN_ENV,
  type SeedTable,
  sqliteImageSeedTables,
} from './pg-template-seed'
import {
  connectPgTest,
  PG_TEST_RUN_ENV,
  PG_TEST_TEMPLATE_ENV,
  PG_TEST_URL_ENV,
  type PgTestClient,
  pgRunPrefix,
  pgUrlForDatabase,
  quotePgIdentifier,
  TEST_STORE_ENGINE_ENV,
} from './pg-test-database'
import { schemaFingerprint } from './pre-migrated-store.build'
import { buildSchemaImage } from './pre-migrated-store.image'

const run = promisify(execFile)

export const PG_TEST_CONTAINER = 'podium-test-pg'
export const PG_TEST_IMAGE = 'postgres:17-bookworm'
export const PG_TEST_PASSWORD = 'podium-test'
/** Loopback port of the host container. 55432 is commonly taken by other projects' dev databases. */
export const PG_TEST_DEFAULT_PORT = 56432
export const PG_TEST_PORT_ENV = 'PODIUM_TEST_PG_PORT'
/**
 * Bumped when the container's settings change. A container with another value is
 * refused rather than replaced, because replacing it would kill other lanes' runs.
 */
const CONTAINER_GENERATION = '1'
const CONTAINER_LABEL = 'podium.test-pg.generation'
/** Databases of runs older than this are a dead lane's, and are dropped. */
export const STALE_RUN_MS = 12 * 60 * 60 * 1000
const LOCK_TIMEOUT_MS = 10 * 60 * 1000
const READY_TIMEOUT_MS = 90 * 1000

/**
 * What the template holds, and the digest that names it.
 *
 * The Postgres migration chain (POD-6981): the template is a database migrated by the
 * real runner, so every clone starts at the head of the chain with its ledger, as the
 * SQLite image does. The digest is the chain's, every migration's name and SQL, so a
 * changed chain builds a new template the way the SQLite image follows
 * `schemaFingerprint`.
 */
export interface PgTemplateSource {
  readonly digest: string
  /** Build the template in the empty database `client` is connected to, at `url`. */
  build(client: PgTestClient, url: string): Promise<void>
}

export function chainTemplateSource(
  migrations: readonly DrizzleMigration[] = PG_MIGRATIONS,
  sqliteSeed: { readonly fingerprint: string; readonly tables: () => SeedTable[] } = {
    fingerprint: schemaFingerprint(),
    tables: () => sqliteImageSeedTables(buildSchemaImage()),
  },
): PgTemplateSource {
  // The SQLite chain is part of what the template holds: its fresh-database rows are
  // the template's starting rows (`pg-template-seed.ts`, POD-6994).
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'pg-chain',
        migrations: migrations.map((m) => [m.name, m.sql]),
        sqliteSeed: sqliteSeed.fingerprint,
      }),
    )
    .digest('hex')
  return {
    digest,
    async build(_client, url) {
      const sql = postgres(url, { max: 1, onnotice: () => {} })
      try {
        await migratePg(sql, migrations)
        await copySeedTables(sql, sqliteSeed.tables())
      } finally {
        await sql.end({ timeout: 5 })
      }
    },
  }
}
export function templateName(digest: string): string {
  return `podium_tpl_${digest.slice(0, 16)}`
}

// ---------------------------------------------------------------------------
// The host lock
// ---------------------------------------------------------------------------

export function hostLockPath(): string {
  return join(homedir(), '.cache', 'podium', hostname(), 'test-pg.lock')
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Run `fn` holding the host lock; a holder whose process is gone is taken over. */
export async function withHostLock<T>(fn: () => Promise<T>, path = hostLockPath()): Promise<T> {
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let reported: number | undefined
  for (;;) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let holder = Number.NaN
    try {
      holder = Number.parseInt(readFileSync(path, 'utf8'), 10)
    } catch {}
    if (!Number.isInteger(holder) || !processIsAlive(holder)) {
      rmSync(path, { force: true })
      continue
    }
    if (Date.now() > deadline) {
      throw new Error(`postgres test harness: ${path} is still held by pid ${holder}`)
    }
    if (reported !== holder) {
      console.error(`postgres test harness: waiting for ${path} (held by pid ${holder})`)
      reported = holder
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  try {
    return await fn()
  } finally {
    try {
      if (readFileSync(path, 'utf8').trim() === String(process.pid)) rmSync(path, { force: true })
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// The container
// ---------------------------------------------------------------------------

function testPort(env: Record<string, string | undefined>): number {
  const configured = env[PG_TEST_PORT_ENV]
  if (!configured) return PG_TEST_DEFAULT_PORT
  const port = Number(configured)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${PG_TEST_PORT_ENV} must be a TCP port, got "${configured}"`)
  }
  return port
}

export function containerAdminUrl(port: number): string {
  return `postgres://postgres:${PG_TEST_PASSWORD}@127.0.0.1:${port}/postgres`
}

async function docker(args: string[]): Promise<string> {
  try {
    const { stdout } = await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code === 'ENOENT') {
      throw new Error(
        'postgres test harness: `docker` is not on PATH. Install Docker, or point ' +
          `${PG_TEST_URL_ENV} at a Postgres 17 server whose maintenance database it names.`,
      )
    }
    throw new Error(`docker ${args[0]} failed: ${failure.stderr?.trim() || failure.message}`)
  }
}

interface ContainerState {
  readonly running: boolean
  readonly generation: string | undefined
  readonly port: string | undefined
}

async function inspectContainer(): Promise<ContainerState | undefined> {
  let raw: string
  try {
    raw = await docker(['container', 'inspect', PG_TEST_CONTAINER])
  } catch (error) {
    if (/no such (container|object)/i.test(String(error))) return undefined
    throw error
  }
  const [info] = JSON.parse(raw) as {
    State: { Running: boolean }
    Config: { Labels?: Record<string, string> }
    HostConfig: { PortBindings?: Record<string, { HostPort: string }[] | null> }
  }[]
  if (info === undefined) return undefined
  return {
    running: info.State.Running,
    generation: info.Config.Labels?.[CONTAINER_LABEL],
    port: info.HostConfig.PortBindings?.['5432/tcp']?.[0]?.HostPort,
  }
}

/** `docker run` arguments for the host container. Exported for the lane test. */
export function containerRunArgs(port: number): string[] {
  return [
    'run',
    '--detach',
    '--name',
    PG_TEST_CONTAINER,
    '--label',
    `${CONTAINER_LABEL}=${CONTAINER_GENERATION}`,
    '--publish',
    `127.0.0.1:${port}:5432`,
    // The data directory lives in memory: nothing here outlives the container, and
    // every write skips the disk. The cap bounds what leaked clones can cost the host.
    '--tmpfs',
    '/var/lib/postgresql/data:rw,size=2g',
    // Docker's 64 MB default /dev/shm is too small for Postgres's parallel workers.
    '--shm-size',
    '256m',
    '--env',
    `POSTGRES_PASSWORD=${PG_TEST_PASSWORD}`,
    PG_TEST_IMAGE,
    // Durability settings only: they change nothing a query can observe, and a
    // tmpfs data directory has nothing to be durable on.
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'full_page_writes=off',
    // Lanes in several worktrees, each with its workers' store pools, share this server.
    '-c',
    'max_connections=300',
  ]
}

async function ensureContainer(port: number): Promise<void> {
  const state = await inspectContainer()
  if (state !== undefined && state.generation !== CONTAINER_GENERATION) {
    throw new Error(
      `postgres test harness: container ${PG_TEST_CONTAINER} has settings generation ` +
        `${state.generation ?? '(none)'}, this checkout expects ${CONTAINER_GENERATION}. ` +
        `When no lane is using it, remove it with \`docker rm -f ${PG_TEST_CONTAINER}\`.`,
    )
  }
  if (state !== undefined && state.port !== String(port)) {
    throw new Error(
      `postgres test harness: container ${PG_TEST_CONTAINER} publishes port ${state.port}, ` +
        `this lane expects ${port} (${PG_TEST_PORT_ENV}).`,
    )
  }
  if (state === undefined) {
    console.error(`postgres test harness: starting ${PG_TEST_CONTAINER} (${PG_TEST_IMAGE})`)
    await docker(containerRunArgs(port))
  } else if (!state.running) {
    console.error(`postgres test harness: restarting ${PG_TEST_CONTAINER}`)
    await docker(['start', PG_TEST_CONTAINER])
  }
}

/**
 * Wait until the server answers on TCP. The image's first start runs initdb on a
 * socket-only server and then restarts, so the TCP port answering is the ready signal.
 */
async function waitUntilReady(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let last: unknown
  while (Date.now() < deadline) {
    const client = connectPgTest(url)
    try {
      await client.unsafe('SELECT 1')
      return
    } catch (error) {
      last = error
    } finally {
      await client.close({ timeout: 1 }).catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`postgres test harness: ${url} did not answer within 90 s: ${String(last)}`)
}

// ---------------------------------------------------------------------------
// Template and sweep
// ---------------------------------------------------------------------------

/**
 * Make sure the template for `source` exists and return its name.
 *
 * It is built under a temporary name and renamed into place, so a lane that dies
 * mid-build leaves no half-built template under the real name, and two lanes that
 * race (in CI there is no host lock) both end up cloning one complete template.
 */
export async function ensureTemplate(adminUrl: string, source: PgTemplateSource): Promise<string> {
  const name = templateName(source.digest)
  const admin = connectPgTest(adminUrl)
  try {
    const existing = await admin.unsafe('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (existing.length > 0) return name
    const building = `podium_tpl_build_${randomBytes(4).toString('hex')}`
    await admin.unsafe(`CREATE DATABASE ${quotePgIdentifier(building)} TEMPLATE template0`)
    const buildingUrl = pgUrlForDatabase(adminUrl, building)
    const target = connectPgTest(buildingUrl)
    try {
      await source.build(target, buildingUrl)
    } finally {
      await target.close({ timeout: 5 })
    }
    try {
      await admin.unsafe(
        `ALTER DATABASE ${quotePgIdentifier(building)} RENAME TO ${quotePgIdentifier(name)}`,
      )
    } catch (error) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quotePgIdentifier(building)} WITH (FORCE)`)
      const raced = await admin.unsafe('SELECT 1 FROM pg_database WHERE datname = $1', [name])
      if (raced.length > 0) return name
      throw error
    }
    // A template nobody connects to: CREATE DATABASE refuses to copy a source that
    // has other sessions, so no stray connection may ever reach it.
    await admin.unsafe(
      `ALTER DATABASE ${quotePgIdentifier(name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
    )
    return name
  } finally {
    await admin.close({ timeout: 5 })
  }
}

/** A new run id: base-36 seconds, then randomness. Its prefix sorts runs by age. */
export function newRunId(now = Date.now()): string {
  return `${Math.floor(now / 1000).toString(36)}_${randomBytes(3).toString('hex')}`
}

/** When run `name` (a `t_…` database) started, or undefined for a name that is not a run's. */
export function runStartedAt(name: string): number | undefined {
  const match = /^t_([0-9a-z]+)_/.exec(name)
  if (match === null) return undefined
  const seconds = Number.parseInt(match[1] as string, 36)
  return Number.isFinite(seconds) ? seconds * 1000 : undefined
}

async function dropWhere(adminUrl: string, keep: (name: string) => boolean): Promise<number> {
  const admin = connectPgTest(adminUrl)
  try {
    const rows = await admin.unsafe<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE starts_with(datname, 't_') OR starts_with(datname, 'podium_tpl_build_')",
    )
    let dropped = 0
    for (const { datname } of rows) {
      if (keep(datname)) continue
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quotePgIdentifier(datname)} WITH (FORCE)`)
      dropped += 1
    }
    return dropped
  } finally {
    await admin.close({ timeout: 5 })
  }
}

/**
 * Drop what dead lanes left: run databases older than {@link STALE_RUN_MS}, and
 * template builds (only a lane holding the host lock builds, and it holds it now).
 */
async function sweepStale(adminUrl: string, now = Date.now()): Promise<number> {
  return dropWhere(adminUrl, (name) => {
    if (name.startsWith('podium_tpl_build_')) return false
    const started = runStartedAt(name)
    return started === undefined || now - started < STALE_RUN_MS
  })
}

// ---------------------------------------------------------------------------
// globalSetup
// ---------------------------------------------------------------------------

/** Find or start the server and build the template. Returns the server's admin URL. */
export async function preparePgTestServer(
  env: Record<string, string | undefined> = process.env,
  source: PgTemplateSource = chainTemplateSource(),
): Promise<{ adminUrl: string; template: string }> {
  const configured = env[PG_TEST_URL_ENV]
  if (configured) {
    await waitUntilReady(configured)
    return { adminUrl: configured, template: await ensureTemplate(configured, source) }
  }
  const port = testPort(env)
  const adminUrl = containerAdminUrl(port)
  return withHostLock(async () => {
    await ensureContainer(port)
    await waitUntilReady(adminUrl)
    const template = await ensureTemplate(adminUrl, source)
    const swept = await sweepStale(adminUrl)
    if (swept > 0) console.error(`postgres test harness: dropped ${swept} stale database(s)`)
    return { adminUrl, template }
  })
}

/**
 * The first admin a clone of `template` holds, read from a throwaway clone (the template
 * itself takes no connections). Named under the run's prefix, so teardown drops it even if
 * this does not.
 */
async function templateFirstAdmin(
  adminUrl: string,
  template: string,
  runId: string,
): Promise<string | undefined> {
  const probe = `${pgRunPrefix(runId)}first_admin`
  const admin = connectPgTest(adminUrl)
  try {
    await admin.unsafe(
      `CREATE DATABASE ${quotePgIdentifier(probe)} TEMPLATE ${quotePgIdentifier(template)} STRATEGY FILE_COPY`,
    )
    const clone = connectPgTest(pgUrlForDatabase(adminUrl, probe))
    try {
      const [row] = await clone.unsafe<{ id: string }>(PG_EARLIEST_ADMIN_SQL)
      return row?.id
    } finally {
      await clone.close({ timeout: 5 })
    }
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quotePgIdentifier(probe)} WITH (FORCE)`)
    await admin.close({ timeout: 5 })
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const { adminUrl, template } = await preparePgTestServer()
  const runId = newRunId()
  // The template's rows are a fresh SQLite store's (`pg-template-seed.ts`), its first
  // admin included; the forks prime it before a test file is imported.
  const firstAdmin = await templateFirstAdmin(adminUrl, template, runId)
  if (firstAdmin === undefined) delete process.env[PG_TEST_FIRST_ADMIN_ENV]
  else process.env[PG_TEST_FIRST_ADMIN_ENV] = firstAdmin
  // Forks inherit the environment; `inject()` would not reach the synchronous
  // module-scope reads the store fixtures make.
  process.env[TEST_STORE_ENGINE_ENV] = 'pg'
  process.env[PG_TEST_URL_ENV] = adminUrl
  process.env[PG_TEST_TEMPLATE_ENV] = template
  process.env[PG_TEST_RUN_ENV] = runId
  return async () => {
    const prefix = pgRunPrefix(runId)
    await dropWhere(adminUrl, (name) => !name.startsWith(prefix))
  }
}
