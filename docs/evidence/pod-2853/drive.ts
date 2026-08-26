/**
 * POD-2853 — can a NAMED instance start a terminal session at all?
 *
 *   bash docs/evidence/pod-2853/drive-up.sh
 *   bun  docs/evidence/pod-2853/drive.ts
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE EXPERIMENT
 * ---------------------------------------------------------------------------
 *
 * One claude-code session is created over the product's own API on an instance
 * that has a name and its own state root, and NOTHING about the durable socket
 * is configured by hand. The row is then read for `spawnFailure` — which is
 * where both reported defects surface, with two different messages.
 *
 * WHAT IS READ, AND WHY IT IS READ TWICE.
 *
 *   ROW      the server's own record: `spawnFailure`, `status`, `durableLabel`.
 *            This is the surface the reporter watched, and it is what a user
 *            sees.
 *   DISK     every directory abduco could have chosen, walked directly, with
 *            the byte length of each socket path printed. This does not care
 *            whether Podium is running.
 *
 * A DISAGREEMENT BETWEEN THEM IS THE SECOND DEFECT, precisely: the row says the
 * session "did not publish a live socket" while the socket is sitting on disk.
 * So the drive prints both on every run, including when they agree, and never
 * concludes "no socket" from the row alone.
 *
 * THE LENGTH IS MEASURED, NEVER ASSUMED. `sizeof(struct sockaddr_un.sun_path)`
 * is 108 on Linux and abduco refuses at `dirlen + label + host >= 108`. The
 * drive prints the composed path and its byte count next to that limit, so the
 * verdict names a number rather than an error string.
 */

import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'

const HOST = process.env.PODIUM_HOST ?? '127.0.0.1'
const PORT = process.env.PODIUM_PORT ?? '19887'
const BASE = `http://${HOST}:${PORT}`
const PASSWORD = process.env.PODIUM_PASSWORD ?? 'p2853'
const DRIVE_BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2853'
const REPO = `${DRIVE_BASE}/repo`
const INSTANCE = process.env.PODIUM_INSTANCE ?? 'p2853'
const STATE = process.env.PODIUM_STATE_DIR ?? `${DRIVE_BASE}/state`
// The agent home is where abduco's `HOME` rung points, and it is overridable
// (docs/multi-instance.md). Reading the instance default here would have made
// the drive report "no socket under ANY root" for a master sitting in an
// overridden one — the exact blindness this issue is about, reproduced in the
// instrument instead of the product.
const AGENT_HOME = process.env.PODIUM_AGENT_HOME ?? `${STATE}/agent-home`
const DB = `${STATE}/podium.db`

// The operator's live instance is 19797 and the default install is 3000. A rig
// that spawned an agent into either would be starting a process in a human's
// mission control.
if (PORT === '19797' || PORT === '3000') throw new Error(`refusing to drive port ${PORT}`)

/** sizeof(struct sockaddr_un.sun_path) on Linux — the whole subject of defect 1. */
const SUN_PATH_MAX = 108
/** How long the spawn gets before the row is read. The socket wait alone is 5s. */
const SPAWN_MS = Number(process.env.P2853_SPAWN_MS ?? 45_000)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString()
const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

let cookie = ''
const login = async () => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
}
const trpc = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE}/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return (await res.json()) as { result?: { data?: unknown }; error?: { message?: string } }
}
/**
 * THE ROW'S `spawnFailure`, STRAIGHT OUT OF THE SERVER'S SQLITE.
 *
 * `sessions.status` does not carry it — it answers status/phase/model and the
 * first run of this rig read `status: "exited"` with an empty failure and
 * called the reproduction INCONCLUSIVE while the reason ("create-session: File
 * name too long") was sitting in the database and in the server log. The field
 * rides the aggregate sync to the UI, not that query, so it is read where the
 * server writes it. Opened read-only per call: the server owns this file.
 */
const spawnFailureOf = (sid: string): string | undefined => {
  if (!existsSync(DB)) return undefined
  const db = new Database(DB, { readonly: true })
  try {
    const row = db.query('select spawn_failure from sessions where id = ?').get(sid) as
      | { spawn_failure: string | null }
      | undefined
    return row?.spawn_failure ?? undefined
  } finally {
    db.close()
  }
}

const trpcQuery = async (path: string, input: unknown) => {
  const url = `${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
  const res = await fetch(url, { headers: { cookie } })
  return (await res.json()) as { result?: { data?: unknown }; error?: { message?: string } }
}

/**
 * Every root abduco could have picked, in ITS resolution order (config.h):
 * ABDUCO_SOCKET_DIR, HOME (personal, so no per-user subdir), TMPDIR, /tmp.
 * Walked directly rather than asked of Podium — the point of this reading is to
 * be independent of the resolver that is under suspicion.
 */
const socketRoots = (): { why: string; dir: string }[] => {
  const user = userInfo().username
  const out: { why: string; dir: string }[] = []
  const asd = process.env.ABDUCO_SOCKET_DIR
  if (asd)
    out.push({ why: 'ABDUCO_SOCKET_DIR (hand-set by the rig)', dir: join(asd, 'abduco', user) })
  // What applyInstanceRuntimeEnv pins for a named instance, at BOTH the shape
  // the pin has today and the shape it would have without the doubled segment.
  out.push({
    why: 'instance pin <state>/runtime/abduco',
    dir: join(STATE, 'runtime', 'abduco', 'abduco', user),
  })
  out.push({ why: 'instance pin <state>/runtime', dir: join(STATE, 'runtime', 'abduco', user) })
  out.push({
    why: 'XDG_RUNTIME_DIR per-instance root',
    dir: join(
      process.env.XDG_RUNTIME_DIR ?? '/run/user/1000',
      `podium-${INSTANCE}`,
      'abduco',
      user,
    ),
  })
  // abduco's own fallbacks, which are where an unpinned spawn lands.
  out.push({ why: "agent HOME/.abduco (abduco's HOME fallback)", dir: join(AGENT_HOME, '.abduco') })
  out.push({ why: 'daemon HOME/.abduco', dir: join(process.env.HOME ?? '/home/mgw', '.abduco') })
  out.push({ why: '/tmp/abduco/<user>', dir: join('/tmp', 'abduco', user) })
  return out
}

/** Sockets on disk carrying this label, with their byte length and liveness.
 *  Liveness is abduco's own convention: S_IXGRP set means the master is holding
 *  an exit status for a TERMINATED app; clear means it is alive. */
const socketsOnDisk = (label: string) => {
  const found: { path: string; bytes: number; live: boolean; why: string }[] = []
  for (const { why, dir } of socketRoots()) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name !== label && !name.startsWith(`${label}@`)) continue
      const path = join(dir, name)
      try {
        const mode = statSync(path).mode
        found.push({ path, bytes: bytes(path), live: (mode & 0o010) === 0, why })
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  return found
}

/** What abduco WOULD compose for this label under the env the daemon ran with,
 *  measured against the limit rather than guessed at. */
const composed = (label: string) => {
  const user = userInfo().username
  const host = `@${hostname()}`
  const rows: { root: string; dir: string; total: number; fits: boolean }[] = []
  for (const { why, dir } of socketRoots()) {
    const dirWithSlash = `${dir}/`
    const total = bytes(dirWithSlash) + bytes(label) + bytes(host)
    rows.push({ root: why, dir: dirWithSlash, total, fits: total < SUN_PATH_MAX })
  }
  return { user, host, rows }
}

// --- the run ---------------------------------------------------------------

console.log(`[${stamp()}] POD-2853 drive — instance '${INSTANCE}'`)
console.log(`  state root         ${STATE}  (${bytes(STATE)} bytes)`)
console.log(
  `  ABDUCO_SOCKET_DIR  ${process.env.ABDUCO_SOCKET_DIR ?? '<unset — the instance must compose its own>'}`,
)
console.log(`  arm                ${process.env.PODIUM_DRIVE_REPO ?? '?'}`)
try {
  const head = execFileSync(
    'git',
    ['-C', process.env.PODIUM_DRIVE_REPO ?? '.', 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim()
  console.log(`  arm HEAD           ${head}`)
} catch {
  /* a detached control checkout may not answer; not evidence either way */
}

await login()
const created = (await trpc('sessions.create', { cwd: REPO, agentKind: 'claude-code' })) as {
  result?: { data?: { sessionId?: string } }
  error?: { message?: string }
}
const sid = created.result?.data?.sessionId
if (!sid) throw new Error(`sessions.create failed: ${JSON.stringify(created)}`)
console.log(`[${stamp()}] session ${sid} created; ${SPAWN_MS}ms for the spawn to settle or fail`)

const label = `podium-${INSTANCE}-${sid}`
console.log(`  durable label      ${label}  (${bytes(label)} bytes)`)

// Poll rather than sleep the whole budget: a spawn that fails fast should be
// reported fast, and a spawn that works should not hold the drive for 45s.
let meta: Record<string, unknown> | undefined
let rowFailure: string | undefined
const deadline = Date.now() + SPAWN_MS
let sawSocket = false
while (Date.now() < deadline) {
  await wait(1_000)
  const r = (await trpcQuery('sessions.status', { ref: sid })) as {
    result?: { data?: Record<string, unknown> }
  }
  meta = r.result?.data
  if (socketsOnDisk(label).length > 0) sawSocket = true
  rowFailure = spawnFailureOf(sid)
  if (rowFailure) break
  if (meta?.status === 'live' && sawSocket) break
}

console.log()
console.log(`--- ROW (the surface a user watches) -------------------------------`)
console.log(`  status         ${String(meta?.status ?? '?')}`)
console.log(`  spawnFailure   ${rowFailure ? JSON.stringify(rowFailure) : '<none>'}`)
console.log(`  durableLabel   ${String(meta?.durableLabel ?? '?')}`)
// THE WHOLE ROW WHENEVER IT IS NOT PLAINLY RUNNING. The first run of this rig
// died on a spawn the SERVER refused before the daemon was ever asked, and
// `status: exited` with an empty spawnFailure said nothing about why. A row
// that failed is evidence; printing three of its fields is a summary.
if (meta?.status !== 'running') console.log(`  full row       ${JSON.stringify(meta ?? null)}`)

console.log()
console.log(`--- DISK (walked directly, independent of Podium's resolver) -------`)
const disk = socketsOnDisk(label)
if (disk.length === 0) {
  console.log('  no socket carrying this label under ANY root abduco could pick')
} else {
  for (const s of disk) {
    console.log(`  ${s.live ? 'LIVE     ' : 'terminated'} ${s.path}`)
    console.log(`             ${s.bytes} bytes   (${s.why})`)
  }
}

console.log()
console.log(`--- COMPOSED LENGTHS vs the ${SUN_PATH_MAX}-byte sun_path limit --------------`)
const c = composed(label)
console.log(`  user=${c.user}  host=${c.host}  label=${bytes(label)}B`)
for (const r of c.rows) {
  console.log(`  ${r.fits ? 'fits  ' : 'OVER  '} ${String(r.total).padStart(3)}B  ${r.dir}`)
  console.log(`           ${r.root}`)
}

console.log()
console.log(`--- VERDICT --------------------------------------------------------`)
const failure = rowFailure ?? ''
const live = disk.filter((s) => s.live)
if (failure.includes('File name too long')) {
  console.log('  DEFECT 1: abduco refused the composed path — it is longer than sun_path.')
} else if (failure.includes('did not publish a live socket') && live.length > 0) {
  console.log('  DEFECT 2: the row says no live socket, and a LIVE socket is on disk.')
  console.log(`            creator wrote ${live[0]?.path}`)
} else if (failure) {
  console.log(`  spawn failed for another reason: ${failure}`)
} else if (live.length > 0 && meta?.status === 'live') {
  console.log('  PASS: the named instance started a terminal session and the socket is live.')
  console.log(`        socket ${live[0]?.path}`)
  console.log(`        ${live[0]?.bytes} bytes, against a ${SUN_PATH_MAX}-byte limit`)
  // A SOCKET IS NOT AN AGENT. The master would be alive with a dead app inside
  // it, so the harness process is confirmed separately — matched on the rig's
  // own agent home, never a bare `claude`, which would hit other sessions on
  // this box.
  const harness = execFileSync('bash', ['-c', `pgrep -fc ${JSON.stringify(AGENT_HOME)} || true`], {
    encoding: 'utf8',
  }).trim()
  console.log(`        ${harness} harness process(es) running under ${AGENT_HOME}`)
} else {
  console.log(
    `  INCONCLUSIVE: no failure recorded, status=${String(meta?.status ?? '?')}, live sockets=${live.length}`,
  )
}
if (existsSync(`${DRIVE_BASE}/logs/daemon.log`)) {
  console.log()
  console.log(`  daemon log: ${DRIVE_BASE}/logs/daemon.log`)
}
