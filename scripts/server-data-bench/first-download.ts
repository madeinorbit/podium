/**
 * FIRST DOWNLOAD AT THE OPERATOR'S SIZE (POD-7153). Run only on a bench VM, never against
 * an operator database: it builds a synthetic database at the operator's row counts,
 * boots two commits' real servers on copies of it, interleaved A B, B A, …, and times a
 * cold device's first download (`GET /sync/bootstrap`, browser client type) end to end.
 * It then runs one arm's producer in process, under `--cpu-prof`, for a CPU profile.
 *
 * The row counts and the record shapes of sessions, issues, offers, checkpoints,
 * conversations and automation runs are POD-7146's (`migration-dry-run.ts` on
 * `issue/7146-migration-dry-run`, 0e11a4dc6d: counts only, read from a backup by hand).
 * The database is built at the schema of every migration before
 * 20261117214033_collection-fetch-indexes, which is 17d01cd9c5's schema; a later arm
 * migrates its copy at boot, before anything is timed.
 *
 *   bun --conditions=@podium/source scripts/server-data-bench/first-download.ts all
 *     --a=<rev> --b=<rev> [--rounds=3] [--per-boot=3] [--root=$HOME/server-data-bench-first-download]
 *     [--profile=b|a|none] [--reseed]
 *
 * Subcommands the orchestrator spawns (each its own process):
 *   seed     --checkout=<arm A> --db=<path>              build the base database
 *   produce  --checkout=<arm> --db=<path> --owner=<id>   one first download in process
 *   collections --checkout=<arm> --db=<path> --owner=<id> per-instance time (POD-7085 arms)
 *   summarize --profile=<file.cpuprofile>                 self and inclusive time by function
 */
import { Database } from 'bun:sqlite'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { CLAUDE_CODE_HARNESS_KIND, HarnessAgent } from '@podium/model'
import { parseArgs } from './seed'

const HARNESS = fileURLToPath(new URL('../..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const BUN = process.execPath
const PASSWORD = 'server-data-bench-password'

/**
 * The operator's row counts: the update backup of 2026-11-18 17:41 UTC, counts only,
 * read in place, read-only and immutable (POD-7146 took the same counts a day earlier).
 */
const REAL_ROWS = {
  sessions: 7246,
  offers: 317,
  runtime_event_checkpoints: 2496,
  session_observation_checkpoints: 4756,
  conversations: 4337,
  issues: 9155,
  automation_runs: 5,
  issue_user_state: 9175,
  issue_git_states: 671,
  issue_deps: 6931,
  session_user_state: 1903,
  user_read_position: 1,
  checkouts: 590,
  pins: 65,
  /** Alive (2,808: input about 120 B, result about 1.5 KB) and deleted (10,021). */
  effects: 12829,
  /** 3,396 confirmed and 327 open chat messages a person sent to a session; the rest mail. */
  messages: 53747,
} as const

/** Shares from the same backup (counts only): what decides which records a download holds. */
const SHARES = {
  effectsAlive: 2808,
  chatConfirmed: 3396,
  chatOpen: 327,
  /** Sessions that carry a resume value (a conversation is its session's). */
  resumed: 5685,
} as const

/** The operator's two agent machines and two repositories (placeholders). */
const MACHINES = [
  '7153a000-0000-4000-a000-000000000001',
  '7153a000-0000-4000-a000-000000000002',
] as const
const REPOS = ['/repo/podium', '/repo/other'] as const

const args = parseArgs(process.argv.slice(3))
const command = process.argv[2]

function out(label: string, value: unknown): void {
  process.stdout.write(`FIRSTDL ${label} ${JSON.stringify(value)}\n`)
}

// ---------------------------------------------------------------- generators (POD-7146's)

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(r: () => number, weighted: ReadonlyArray<readonly [T, number]>): T {
  const total = weighted.reduce((s, [, w]) => s + w, 0)
  let x = r() * total
  for (const [v, w] of weighted) {
    x -= w
    if (x < 0) return v
  }
  return weighted[weighted.length - 1]![0]
}

/** The newest record is a day old, as on a device that opens the app after a day away. */
const T1 = Date.now() - 3_600_000
/** The operator's oldest issue is 147 days older than the backup. */
const T0 = T1 - 147 * 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const pad = (r: () => number, n: number) => {
  const chars = 'abcdefghijklmnopqrstuvwxyz      0123456789'
  let s = ''
  for (let i = 0; i < n; i++) s += chars[Math.floor(r() * chars.length)]
  return s
}

const PHASES = [
  ['working', 20],
  ['idle', 40],
  ['idle:question', 8],
  ['idle:approval', 4],
  ['needs_user', 8],
  ['errored', 5],
  ['stopped', 15],
] as const

function turnState(r: () => number, padLen: number): Record<string, unknown> {
  const p = pick(r, PHASES)
  const base: Record<string, unknown> = p.startsWith('idle')
    ? { phase: 'idle', idle: { kind: p === 'idle' ? 'done' : p.slice(5) } }
    : { phase: p }
  return { ...base, since: iso(T0 + r() * (T1 - T0)), detail: pad(r, padLen) }
}

function stateText(r: () => number, padLen: number, nullShare: number): string | null {
  const x = r()
  if (x < nullShare) return null
  if (x < nullShare + 0.01) return '{"phase": "needs_user"'
  if (x < nullShare + 0.02) return '["needs_user"]'
  return JSON.stringify(turnState(r, padLen))
}

// ---------------------------------------------------------------- seed

async function seed(): Promise<void> {
  const checkout = resolve(args.checkout!)
  const dbPath = resolve(args.db!)
  for (const s of ['', '-wal', '-shm']) rmSync(`${dbPath}${s}`, { force: true })
  const started = performance.now()
  // The arm's own store builds its schema and the first admin, as a
  // fresh install does; the rows below are written after it closes, below the change log.
  const { SessionStore } = await import(join(checkout, 'apps/server/src/store.ts'))
  const model = await import(join(checkout, 'packages/model/src/index.ts'))
  const store = await SessionStore.open(dbPath, undefined, { changeCapture: 'whenLogAttaches' })
  const owner = String(await model.firstAdminMemberId(store))
  model.primeFirstAdminMember(owner)
  // A server that finds enrolled machines and no update signing key refuses to start.
  const signingKey = join(checkout, 'packages/runtime/src/update-signing-key.ts')
  if (existsSync(signingKey))
    (await import(signingKey)).readOrCreateUpdateSigningKey(dirname(dbPath))
  await store.transact(async () => {
    for (const [index, machine] of MACHINES.entries()) {
      await store.machines.upsertMachine({
        id: machine,
        name: `bench-${index}`,
        hostname: `bench-${index}.example`,
        tokenHash: createHash('sha256').update(`bench-token-${index}`).digest('hex'),
        ownerUserId: owner,
        assignment: { server: false, agentExecution: true },
      })
    }
    for (const [index, path] of REPOS.entries())
      await store.repos.addRepo(path, MACHINES[index % MACHINES.length]!)
  })
  await store.close()

  const db = new Database(dbPath)
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF')
  const r = rng(7146)
  const repoIds = new Map(
    (
      db.prepare('SELECT path, repo_id FROM repos').all() as Array<{
        path: string
        repo_id: string
      }>
    ).map((row) => [row.path, row.repo_id]),
  )

  const issueIds: string[] = []
  const insIssue = db.prepare(
    `INSERT INTO issues (id, owner_user_id, created_by_actor, created_by_on_behalf_of, repo_path, repo_id, seq,
       title, description, brief, stage, default_agent, parent_id, priority, archived, deleted_at, created_at,
       updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  db.transaction(() => {
    for (let i = 0; i < REAL_ROWS.issues; i++) {
      const id = `iss_bench${String(i).padStart(6, '0')}`
      const created = T0 + r() * (T1 - T0)
      const stage = pick(r, [
        ['done', 5265],
        ['proposed', 1904],
        ['backlog', 1094],
        ['review', 526],
        ['in_progress', 210],
        ['planning', 91],
      ] as const)
      const parent = i > 10 && r() < 0.3 ? issueIds[Math.floor(r() * issueIds.length)]! : null
      const deleted = r() < 0.007 ? iso(created + 3_600_000) : null
      const repo = r() < 0.7 ? REPOS[0] : REPOS[1]
      insIssue.run(
        id,
        owner,
        owner,
        owner,
        repo,
        repoIds.get(repo) ?? null,
        i + 1,
        pad(r, 50),
        pad(r, 2300),
        r() < 0.6 ? pad(r, 1500) : null,
        stage,
        CLAUDE_CODE_HARNESS_KIND,
        parent,
        Math.floor(r() * 5),
        r() < 0.2 ? 1 : 0,
        deleted,
        iso(created),
        iso(Math.min(T1, created + r() * 86_400_000 * 5)),
        stage === 'done' ? iso(created + 86_400_000) : null,
      )
      issueIds.push(id)
    }
  })()

  type S = { id: string; lastInput: number | null; active: boolean }
  const sessions: S[] = []
  const insSession = db.prepare(
    `INSERT INTO sessions (id, owner_user_id, agent_kind, model, cwd, title, origin_kind, status, durable_label,
       created_at, last_active_at, published_last_active_at, archived, machine_id, last_input_at, issue_id,
       deleted_at, agent_state_json, launch_posture_json)
     VALUES (?, ?, ?, 'claude-opus-5-5', ?, ?, 'spawn', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  db.transaction(() => {
    for (let i = 0; i < REAL_ROWS.sessions; i++) {
      const id = `ses_bench${String(i).padStart(6, '0')}`
      const created = T0 + r() * (T1 - T0)
      // Live conversations (not exited, archived or deleted), exited, archived, deleted.
      const kind = pick(r, [
        ['active', 3926],
        ['exited', 505],
        ['archived', 2404],
        ['deleted', 411],
      ] as const)
      const lastInput = r() < 0.8 ? created + r() * 86_400_000 : null
      const lastActive = created + r() * 86_400_000 * 2
      insSession.run(
        id,
        owner,
        pick(r, [
          [CLAUDE_CODE_HARNESS_KIND, 70],
          [HarnessAgent.enum.codex, 20],
          [HarnessAgent.enum.pi, 10],
        ] as const),
        `/repo/podium/.worktrees/issue-${Math.floor(r() * 9000)}`,
        pad(r, 40),
        kind === 'active' ? 'running' : 'exited',
        `S-${i}`,
        iso(created),
        iso(lastActive),
        r() < 0.9 ? iso(lastActive) : '',
        kind === 'archived' ? 1 : 0,
        r() < 0.6 ? MACHINES[0] : MACHINES[1],
        lastInput === null ? null : iso(lastInput),
        r() < 0.8 ? issueIds[Math.floor(r() * issueIds.length)]! : null,
        kind === 'deleted' ? iso(lastActive + 60_000) : null,
        stateText(r, 230, 0.15),
        JSON.stringify({ posture: pad(r, 20) }),
      )
      sessions.push({ id, lastInput, active: kind === 'active' })
    }
  })()

  const sample = (n: number, activeShare: number): S[] => {
    const active = sessions.filter((s) => s.active)
    const rest = sessions.filter((s) => !s.active)
    const chosen = new Set<S>()
    while (chosen.size < n) {
      const pool = r() < activeShare && chosen.size < active.length ? active : rest
      chosen.add(pool[Math.floor(r() * pool.length)]!)
    }
    return [...chosen]
  }

  const insOffer = db.prepare(
    'INSERT INTO offers (session_id, message, actions, artifacts, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (const s of sample(REAL_ROWS.offers, 0.6)) {
      const anchor = s.lastInput ?? T0 + r() * (T1 - T0)
      const x = r()
      const created =
        x < 0.01
          ? ''
          : iso(x < 0.5 ? anchor + 60_000 + r() * 3_600_000 : anchor - 60_000 - r() * 3_600_000)
      insOffer.run(
        s.id,
        pad(r, 560),
        JSON.stringify([
          { label: 'Merge', prompt: pad(r, 160) },
          { label: 'Send back', prompt: pad(r, 80) },
        ]),
        r() < 0.4 ? JSON.stringify([`artifact-${pad(r, 20)}.png`]) : null,
        created,
      )
    }
  })()

  const insRuntime = db.prepare(
    `INSERT INTO runtime_event_checkpoints (session_id, observer_generation, cursor_json, turn_epoch,
       closed_turn_epoch, updated_at, turn_state_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  db.transaction(() => {
    for (const s of sample(REAL_ROWS.runtime_event_checkpoints, 0.5)) {
      const epoch = Math.floor(r() * 200)
      insRuntime.run(
        s.id,
        1 + Math.floor(r() * 5),
        JSON.stringify({
          file: `/home/agent/.claude/projects/${pad(r, 60)}.jsonl`,
          offset: Math.floor(r() * 1e7),
          tail: pad(r, 260),
        }),
        epoch,
        r() < 0.7 ? epoch : null,
        iso(T0 + r() * (T1 - T0)),
        stateText(r, 60, 0.1),
      )
    }
  })()

  const insObs = db.prepare(
    `INSERT INTO session_observation_checkpoints (session_id, schema_version, provider, provider_session_id,
       binding_version, observation_generation, checkpoint_json, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
  )
  db.transaction(() => {
    for (const s of sample(REAL_ROWS.session_observation_checkpoints, 0.3)) {
      const x = r()
      const body = { transcript: { tail: pad(r, 5100) }, cursor: Math.floor(r() * 1e6) }
      const json =
        x < 0.02
          ? null
          : x < 0.03
            ? '{"turnState": {"phase": "errored"'
            : x < 0.05
              ? JSON.stringify({ ...body, turnState: 'needs_user' })
              : x < 0.2
                ? JSON.stringify(body)
                : JSON.stringify({ ...body, turnState: turnState(r, 40) })
      insObs.run(
        s.id,
        CLAUDE_CODE_HARNESS_KIND,
        `prov-${pad(r, 12)}`,
        1,
        Math.floor(r() * 9),
        json,
        iso(T0 + r() * (T1 - T0)),
      )
    }
  })()

  const insConv = db.prepare(
    `INSERT INTO conversations (id, agent_kind, provider_id, title, summary, project_path, created_at, updated_at,
       message_count, machine_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  db.transaction(() => {
    for (let i = 0; i < REAL_ROWS.conversations; i++) {
      const created = T0 + r() * (T1 - T0)
      insConv.run(
        `conv_bench${String(i).padStart(6, '0')}`,
        CLAUDE_CODE_HARNESS_KIND,
        `prov-${i}`,
        pad(r, 70),
        pad(r, 1150),
        `/repo/podium/.worktrees/issue-${Math.floor(r() * 9000)}`,
        r() < 0.05 ? null : iso(created),
        iso(Math.min(T1, created + r() * 86_400_000)),
        Math.floor(r() * 400),
        r() < 0.6 ? MACHINES[0] : MACHINES[1],
      )
    }
  })()

  const insRun = db.prepare(
    `INSERT INTO automation_runs (id, on_behalf_of, automation_id, fired_at, outcome) VALUES (?, ?, 'aut_bench', ?, 'spawned')`,
  )
  for (let i = 0; i < REAL_ROWS.automation_runs; i++)
    insRun.run(`arun_bench${i}`, owner, iso(T1 - i * 86_400_000))

  // A conversation is its session's: visible through the session that resumes it.
  const resume = db.prepare('UPDATE sessions SET resume_value = ? WHERE id = ?')
  db.transaction(() => {
    for (let i = 0; i < SHARES.resumed; i++)
      resume.run(
        i < REAL_ROWS.conversations
          ? `conv_bench${String(i).padStart(6, '0')}`
          : `prov-unlisted-${i}`,
        sessions[i]!.id,
      )
  })()

  seedSideTables(
    db,
    r,
    owner,
    issueIds,
    sessions.map((s) => ({ id: s.id, live: s.active })),
  )

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const rows: Record<string, number> = {}
  for (const t of Object.keys(REAL_ROWS))
    rows[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
  db.close()
  writeFileSync(join(dbPath, '..', 'owner.txt'), owner)
  out('seed', { owner, rows, seedMs: Math.round(performance.now() - started) })
}

/** The synced side tables the first download also reads, at the operator's counts. */

function seedSideTables(
  db: Database,
  r: () => number,
  owner: string,
  issueIds: readonly string[],
  sessions: ReadonlyArray<{ id: string; live: boolean }>,
): void {
  const sessionIds = sessions.map((s) => s.id)
  const some = <T>(items: readonly T[], n: number): T[] => {
    const chosen = new Set<T>()
    while (chosen.size < Math.min(n, items.length))
      chosen.add(items[Math.floor(r() * items.length)]!)
    return [...chosen]
  }
  const at = () => iso(T0 + r() * (T1 - T0))
  const sha = () => createHash('sha1').update(String(r())).digest('hex')
  db.transaction(() => {
    const userState = db.prepare(
      `INSERT INTO issue_user_state (user_id, issue_id, read_at, tucked_at, joined_at, joined_via)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const id of some(issueIds, REAL_ROWS.issue_user_state)) {
      const joined = r() < 0.6
      userState.run(
        owner,
        id,
        at(),
        r() < 0.05 ? at() : null,
        joined ? at() : null,
        joined ? 'start' : null,
      )
    }
    const git = db.prepare(
      'INSERT INTO issue_git_states (issue_id, facts_json, updated_at) VALUES (?, ?, ?)',
    )
    for (const id of some(issueIds, REAL_ROWS.issue_git_states)) {
      const facts = {
        branch: `issue/${id.slice(-6)}-${pad(r, 24).replace(/ /g, '-')}`,
        shared: false,
        ahead: Math.floor(r() * 12),
        dirtyFiles: Math.floor(r() * 4),
        dirtyOwn: Math.floor(r() * 3),
        commits: Array.from({ length: Math.floor(r() * 4) }, sha),
        lastCommitAt: at(),
        merged: r() < 0.6,
      }
      git.run(id, JSON.stringify(facts), at())
    }
    const dep = db.prepare(
      'INSERT OR IGNORE INTO issue_deps (from_id, to_id, type) VALUES (?, ?, ?)',
    )
    for (let i = 0; i < REAL_ROWS.issue_deps; i++) {
      const from = issueIds[Math.floor(r() * issueIds.length)]!
      const to = issueIds[Math.floor(r() * issueIds.length)]!
      if (from !== to)
        dep.run(
          from,
          to,
          pick(r, [
            ['discovered-from', 50],
            ['blocked-by', 35],
            ['related', 15],
          ] as const),
        )
    }
    const sessionState = db.prepare(
      'INSERT INTO session_user_state (user_id, session_id, read_at) VALUES (?, ?, ?)',
    )
    for (const id of some(sessionIds, REAL_ROWS.session_user_state))
      sessionState.run(owner, id, at())
    const read = db.prepare(
      'INSERT INTO user_read_position (user_id, stream_id, last_event_id, seen_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    for (let i = 0; i < REAL_ROWS.user_read_position; i++)
      read.run(owner, `issue:${issueIds[i % issueIds.length]}`, Math.floor(r() * 1e6), at(), at())
    const checkout = db.prepare(
      `INSERT INTO checkouts (machine_id, path, root, kind, repo_id, branch, origin_url, updated_at)
       SELECT ?, ?, ?, ?, repo_id, ?, NULL, ? FROM repos WHERE path = ?`,
    )
    for (let i = 0; i < REAL_ROWS.checkouts; i++) {
      const root = REPOS[i % REPOS.length]!
      const machine = MACHINES[i % MACHINES.length]!
      const isRoot = i < REPOS.length
      checkout.run(
        machine,
        isRoot ? root : `${root}/.worktrees/issue-${i}-${pad(r, 20).replace(/ /g, '-')}`,
        root,
        isRoot ? 'repository' : 'worktree',
        isRoot ? 'main' : `issue/${i}`,
        at(),
        root,
      )
    }
    const pin = db.prepare(
      'INSERT OR IGNORE INTO pins (user_id, kind, id, pinned_at) VALUES (?, ?, ?, ?)',
    )
    for (const id of some(issueIds, REAL_ROWS.pins)) pin.run(owner, 'issue', id, at())
    const effect = db.prepare(
      `INSERT INTO effects (id, kind, target_kind, target_id, input_json, result_json, status, created_by, actor,
         created_at, updated_at, started_at, finished_at, deleted_at) VALUES (?, ?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (let i = 0; i < REAL_ROWS.effects; i++) {
      const alive = i < SHARES.effectsAlive
      const created = T0 + r() * (T1 - T0)
      const issue = issueIds[Math.floor(r() * issueIds.length)]!
      effect.run(
        `eff_bench${String(i).padStart(6, '0')}`,
        pick(r, [
          ['issue.start', 50],
          ['file.write', 30],
          ['session.answer', 20],
        ] as const),
        issue,
        JSON.stringify({ issueId: issue, note: pad(r, alive ? 70 : 2) }),
        JSON.stringify({ ok: true, detail: pad(r, alive ? 1420 : 5380) }),
        'succeeded',
        owner,
        `user:${owner}`,
        Math.floor(created),
        Math.floor(created + 5000),
        Math.floor(created + 100),
        Math.floor(created + 4000),
        alive ? null : Math.floor(Math.min(T1, created + 86_400_000)),
      )
    }
    const live = sessions.filter((s) => s.live)
    const message = db.prepare(
      `INSERT INTO messages (id, thread_id, from_kind, from_session, actor_kind, actor_id, on_behalf_of, to_kind, to_id,
         body, created_at, delivery_status) VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (let i = 0; i < REAL_ROWS.messages; i++) {
      const chat = i < SHARES.chatConfirmed + SHARES.chatOpen
      const to = chat
        ? live[Math.floor(r() * live.length)]!.id
        : sessions[Math.floor(r() * sessions.length)]!.id
      const id = `msg_bench${String(i).padStart(7, '0')}`
      message.run(
        id,
        `thr_${id}`,
        chat ? 'operator' : 'agent',
        chat ? null : sessions[Math.floor(r() * sessions.length)]!.id,
        owner,
        owner,
        chat ? 'session' : 'issue',
        chat ? to : issueIds[Math.floor(r() * issueIds.length)]!,
        pad(r, chat ? 480 : 900),
        at(),
        chat && i >= SHARES.chatConfirmed ? 'stored' : 'confirmed',
      )
    }
  })()
}

// ---------------------------------------------------------------- one download, as a browser

interface Download {
  status: number
  coding: string | null
  transferId: string | null
  headersMs: number
  firstByteMs: number
  endMs: number
  wireBytes: number
  rawBytes: number
  lines: Record<string, number>
  rows: number
  /** Rows and value bytes by `<entity>/<whole|stub>`. */
  byKind: Record<string, { rows: number; bytes: number }>
}

async function download(origin: string, cookie: string): Promise<Download> {
  const started = performance.now()
  const response = await fetch(`${origin}/sync/bootstrap`, {
    headers: {
      cookie,
      origin,
      'accept-encoding': 'gzip, deflate, br, zstd',
      'Podium-Client-Type': 'browser',
      'Podium-Sync-Client': randomUUID(),
    },
    decompress: false,
  } as RequestInit)
  const headersMs = performance.now() - started
  const reader = response.body!.getReader()
  const parts: Uint8Array[] = []
  let firstByteMs = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    if (parts.length === 0) firstByteMs = performance.now() - started
    parts.push(next.value)
  }
  const endMs = performance.now() - started
  const wire = Buffer.concat(parts)
  const coding = response.headers.get('content-encoding')
  const raw =
    coding === 'zstd' ? zstdDecompressSync(wire) : coding === 'gzip' ? gunzipSync(wire) : wire
  const lines: Record<string, number> = {}
  const byKind: Record<string, { rows: number; bytes: number }> = {}
  let rows = 0
  for (const text of raw.toString('utf8').split('\n')) {
    if (text === '') continue
    const line = JSON.parse(text) as { type: string; changes?: Array<Record<string, unknown>> }
    lines[line.type] = (lines[line.type] ?? 0) + 1
    for (const change of line.changes ?? []) {
      rows++
      const key = `${String(change.entity)}/${change.part === 'stub' || line.type === 'feedStubs' ? 'stub' : 'whole'}`
      byKind[key] ??= { rows: 0, bytes: 0 }
      const slot = byKind[key]
      slot.rows++
      slot.bytes += JSON.stringify(change).length
    }
  }
  return {
    status: response.status,
    coding,
    transferId: response.headers.get('podium-transfer-id'),
    headersMs,
    firstByteMs,
    endMs,
    wireBytes: wire.byteLength,
    rawBytes: raw.byteLength,
    lines,
    rows,
    byKind,
  }
}

// ---------------------------------------------------------------- one arm's server

interface Arm {
  label: 'A' | 'B'
  sha: string
  checkout: string
}

function git(cwd: string, ...a: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${a.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function checkoutFor(sha: string, root: string): string {
  const dir = join(root, 'checkouts', sha.slice(0, 12))
  if (!existsSync(join(dir, '.bench-ready'))) {
    if (!existsSync(dir)) git(HARNESS, 'worktree', 'add', '--detach', dir, sha)
    const install = spawnSync(BUN, ['install', '--frozen-lockfile'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'inherit',
    })
    if (install.status !== 0) throw new Error(`bun install failed in ${dir}`)
    writeFileSync(join(dir, '.bench-ready'), sha)
  }
  return dir
}

function prepareRoot(root: string): void {
  rmSync(root, { recursive: true, force: true })
  for (const name of [
    'home',
    'tmp',
    'runtime',
    'cache',
    'config',
    'data',
    'xdg-state',
    'abduco',
    'state',
  ])
    mkdirSync(join(root, name), { recursive: true, mode: 0o700 })
}

interface Server {
  child: ChildProcess
  port: number
  logs: Array<Record<string, unknown>>
  bootMs: number
}

async function boot(arm: Arm, root: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Server> {
  const child = spawn(
    BUN,
    [
      '--conditions=@podium/source',
      join(HARNESS, 'scripts/server-data-bench/serve.ts'),
      `--checkout=${arm.checkout}`,
    ],
    {
      cwd: arm.checkout,
      env: { ...(await import('./run')).benchEnvironment(root), ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const logs: Array<Record<string, unknown>> = []
  const errors: string[] = []
  createInterface({ input: child.stderr! }).on('line', (l) => {
    errors.push(l)
    if (errors.length > 200) errors.shift()
  })
  return await new Promise<Server>((resolveBoot, rejectBoot) => {
    const timer = setTimeout(
      () => rejectBoot(new Error(`boot timed out:\n${errors.join('\n')}`)),
      300_000,
    )
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectBoot(new Error(`server exited ${code}:\n${errors.slice(-60).join('\n')}`))
    })
    createInterface({ input: child.stdout! }).on('line', (l) => {
      let record: Record<string, unknown>
      try {
        record = JSON.parse(l)
      } catch {
        return
      }
      if (record.benchReady) {
        clearTimeout(timer)
        resolveBoot({ child, port: Number(record.port), logs, bootMs: Number(record.bootMs) })
      } else logs.push(record)
    })
  })
}

async function stop(server: Server): Promise<void> {
  server.child.removeAllListeners('exit')
  const exited = new Promise<void>((done) => server.child.once('exit', () => done()))
  server.child.stdin!.write('stop\n')
  const timeout = setTimeout(() => server.child.kill('SIGKILL'), 30_000)
  await exited
  clearTimeout(timeout)
}

async function login(origin: string): Promise<string> {
  const response = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ password: PASSWORD }),
  })
  if (!response.ok) throw new Error(`login failed (${response.status}): ${await response.text()}`)
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** The server's own line for one transfer (`sync transfer finished`), with every field it logs. */
function serverLine(
  server: Server,
  transferId: string | null,
): Record<string, unknown> | undefined {
  return server.logs.find(
    (record) =>
      JSON.stringify(record).includes('sync transfer finished') &&
      JSON.stringify(record).includes(String(transferId)),
  )
}

async function armRun(
  arm: Arm,
  base: string,
  root: string,
  round: number,
  perBoot: number,
): Promise<unknown[]> {
  const armRoot = join(root, `arm-${arm.label}`)
  prepareRoot(armRoot)
  // The database and what the seed's store wrote beside it (the update signing key).
  for (const name of readdirSync(dirname(base)))
    if (name !== 'owner.txt')
      cpSync(join(dirname(base), name), join(armRoot, 'state', name), { recursive: true })
  const server = await boot(arm, armRoot)
  const origin = `http://127.0.0.1:${server.port}`
  // Boot work (migrations of the later arm, backfills, first reads) settles first.
  await sleep(8000)
  const cookie = await login(origin)
  const results: unknown[] = []
  for (let n = 1; n <= perBoot; n++) {
    const loadBefore = readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')
    const result = await download(origin, cookie)
    await sleep(1500)
    const line = serverLine(server, result.transferId)
    const row = {
      arm: arm.label,
      sha: arm.sha.slice(0, 10),
      round,
      n,
      bootMs: Math.round(server.bootMs),
      loadBefore,
      ...result,
      server: line,
    }
    out('download', row)
    results.push(row)
    await sleep(1500)
  }
  await stop(server)
  return results
}

// ---------------------------------------------------------------- in process

function userPrincipal(owner: string) {
  return { kind: 'user', user: owner, device: 'dev_bench', capability: 'cap_bench' }
}

async function produce(): Promise<void> {
  const checkout = resolve(args.checkout!)
  const { produceBootstrap } = await import(
    join(checkout, 'apps/server/src/sync-worker/producer.ts')
  )
  const encoding = (args.encoding ?? 'zstd') as 'zstd' | 'identity' | 'gzip'
  const runs = Number(args.runs ?? 1)
  const saved: Uint8Array[] = []
  for (let n = 1; n <= runs; n++) {
    saved.length = 0
    const started = performance.now()
    let bytes = 0
    let firstMs = 0
    let metrics: unknown
    for await (const chunk of produceBootstrap(
      resolve(args.db!),
      {
        transferId: randomUUID(),
        principal: userPrincipal(args.owner!),
        feedId: 'feed_bench',
        epoch: 'epoch_bench',
        encoding,
        clientType: 'browser',
      },
      new AbortController().signal,
      () => {},
      (m: unknown) => {
        metrics = m
      },
      {},
    ) as AsyncIterable<Uint8Array>) {
      if (bytes === 0) firstMs = performance.now() - started
      bytes += chunk.byteLength
      if (args.save) saved.push(chunk)
    }
    if (args.save) writeFileSync(resolve(args.save), Buffer.concat(saved))
    out('produce', {
      n,
      encoding,
      ms: Math.round(performance.now() - started),
      firstMs: Math.round(firstMs),
      bytes,
      metrics,
    })
  }
  // What the statements cost, summed over the runs (the server's own attribution).
  const attribution = join(checkout, 'packages/runtime/src/query-attribution.ts')
  if (existsSync(attribution)) {
    const totals = [...(await import(attribution)).queryAttributionTotals().entries()] as Array<
      [string, { count: number; wallMs: number; rows: number }]
    >
    const top = totals.sort((a, b) => b[1].wallMs - a[1].wallMs).slice(0, 25)
    for (const [key, cost] of top)
      out('statement', {
        runs,
        wallMs: Math.round(cost.wallMs),
        count: cost.count,
        rows: cost.rows,
        key: key.slice(0, 220),
      })
    // Who issued the costliest statements, under PODIUM_LOOP_PROFILE=full (`--stacks`).
    const attributionModule = await import(attribution)
    if (attributionModule.queryCallerStacksEnabled) {
      const stacks = attributionModule.queryCallerStacks() as Map<
        string,
        Array<{ count: number; stack: string }>
      >
      for (const [key] of top.slice(0, 4))
        for (const { count, stack } of (stacks.get(key) ?? []).slice(0, 8))
          out('caller', {
            key: key.slice(-9),
            count,
            stack: stack.split('\n').slice(0, 14).join(' | '),
          })
    }
  }
}

/** Per instance of the first download: its time and its records, inside one snapshot. */
async function collections(): Promise<void> {
  const checkout = resolve(args.checkout!)
  const { openDatabase } = await import(join(checkout, 'packages/runtime/src/sqlite/index.ts'))
  const { bootstrapVisibility } = await import(
    join(checkout, 'apps/server/src/sync-worker/visibility.ts')
  )
  const { CollectionAnswer, resolveInstance } = await import(
    join(checkout, 'apps/server/src/sync/collection-fetch.ts')
  )
  const { firstDownload, policyFor } = await import(
    join(checkout, 'apps/server/src/sync/policy.ts')
  )
  const db = openDatabase(resolve(args.db!), { readOnly: true })
  db.exec('PRAGMA query_only = ON; BEGIN')
  const t0 = performance.now()
  const bundle = bootstrapVisibility(db, {})
  const context = await bundle.context
  await context.sync.readFeedState()
  out('capture', { ms: Math.round(performance.now() - t0) })
  const policy = policyFor('browser')
  const answer = new CollectionAnswer({
    collections: context.collections,
    records: context.records,
    visibility: context.policy,
    principal: userPrincipal(args.owner!),
    now: Date.now(),
    policyArgs: { recentDays: policy.recentDays },
  })
  const total = performance.now()
  for (const instance of firstDownload(policy, [])) {
    const started = performance.now()
    const counts: Record<string, number> = {}
    let markers = 0
    for await (const output of answer.instance(resolveInstance(instance))) {
      if (output.type === 'complete') {
        markers += output.instances.length
        continue
      }
      for (const record of output.records) {
        const key = `${record.entity}/${output.type === 'stubs' ? 'stub' : 'whole'}`
        counts[key] = (counts[key] ?? 0) + 1
      }
    }
    out('instance', {
      collection: instance.collection,
      ms: Math.round(performance.now() - started),
      markers,
      counts,
    })
  }
  out('instances-total', { ms: Math.round(performance.now() - total) })
  db.exec('ROLLBACK')
  await bundle.executor.close()
}

/** Self time and inclusive time by function of a `.cpuprofile`. */
function summarize(): void {
  const profile = JSON.parse(readFileSync(args.profile!, 'utf8')) as {
    nodes: Array<{
      id: number
      callFrame: { functionName: string; url: string; lineNumber: number }
      children?: number[]
    }>
    samples: number[]
    timeDeltas: number[]
  }
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id)
  const name = (id: number) => {
    const f = byId.get(id)!.callFrame
    const file = f.url.replace(/^.*\/(apps|packages|node_modules)\//, '$1/')
    return `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}`
  }
  const self = new Map<string, number>()
  const inclusive = new Map<string, number>()
  let totalUs = 0
  profile.samples.forEach((id, at) => {
    const us = profile.timeDeltas[at + 1] ?? profile.timeDeltas[at] ?? 0
    totalUs += us
    self.set(name(id), (self.get(name(id)) ?? 0) + us)
    const seen = new Set<string>()
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const n = name(cur)
      if (seen.has(n)) continue
      seen.add(n)
      inclusive.set(n, (inclusive.get(n) ?? 0) + us)
    }
  })
  const top = (m: Map<string, number>, k: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(
        ([n, us]) =>
          `${(us / 1000).toFixed(0).padStart(7)} ms ${((100 * us) / totalUs).toFixed(1).padStart(5)}%  ${n}`,
      )
  console.log(`total sampled ${(totalUs / 1000).toFixed(0)} ms`)
  console.log('--- self')
  for (const l of top(self, Number(args.top ?? 45))) console.log(l)
  console.log('--- inclusive')
  for (const l of top(inclusive, Number(args.top ?? 80))) console.log(l)
}

// ---------------------------------------------------------------- orchestration

function child(argv: string[], options: { cwd: string; prefix?: string[] }): string {
  const result = spawnSync(
    BUN,
    [...(options.prefix ?? []), '--conditions=@podium/source', SELF, ...argv],
    {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 256 << 20,
      env: {
        ...process.env,
        PODIUM_TELEMETRY: 'off',
        PODIUM_LOOP_PROFILE: argv.includes('--stacks') ? 'full' : 'attribution',
      },
    },
  )
  process.stdout.write(result.stdout)
  if (result.status !== 0)
    throw new Error(`${argv[0]} failed (${result.status}):\n${result.stderr.slice(-4000)}`)
  return result.stdout
}

async function all(): Promise<void> {
  const root = resolve(args.root ?? join(homedir(), 'server-data-bench-first-download'))
  mkdirSync(root, { recursive: true })
  const arms: Arm[] = (['A', 'B'] as const).map((label) => {
    const sha = git(HARNESS, 'rev-parse', args[label.toLowerCase()]!)
    return { label, sha, checkout: checkoutFor(sha, root) }
  })
  const baseDir = join(root, 'base')
  const base = join(baseDir, 'podium.db')
  if (args.reseed === 'true' || !existsSync(base)) {
    rmSync(baseDir, { recursive: true, force: true })
    mkdirSync(baseDir, { recursive: true })
    child(['seed', `--checkout=${arms[0]!.checkout}`, `--db=${base}`], { cwd: arms[0]!.checkout })
  }
  const owner = readFileSync(join(baseDir, 'owner.txt'), 'utf8').trim()
  const rounds = Number(args.rounds ?? 3)
  const perBoot = Number(args['per-boot'] ?? 3)
  for (let round = 1; round <= rounds; round++) {
    const order = round % 2 === 1 ? arms : [...arms].reverse()
    for (const arm of order) await armRun(arm, base, root, round, perBoot)
  }
  const profiled = args.profile ?? 'b'
  for (const arm of arms) {
    // In process, on the copy the arm's server migrated and served from.
    const db = join(root, `arm-${arm.label}`, 'state', 'podium.db')
    child(['produce', `--checkout=${arm.checkout}`, `--db=${db}`, `--owner=${owner}`, '--runs=2'], {
      cwd: arm.checkout,
    })
    const body = join(root, `body-${arm.label}.ndjson`)
    child(
      [
        'produce',
        `--checkout=${arm.checkout}`,
        `--db=${db}`,
        `--owner=${owner}`,
        '--runs=1',
        '--encoding=identity',
        `--save=${body}`,
      ],
      { cwd: arm.checkout },
    )
    // What the content coding costs on this arm's own body.
    const micro = spawnSync(
      BUN,
      [
        '--conditions=@podium/source',
        join(HARNESS, 'scripts/server-data-bench/zstd-pipe.ts'),
        `--checkout=${arm.checkout}`,
        `--body=${body}`,
      ],
      { cwd: arm.checkout, encoding: 'utf8' },
    )
    process.stdout.write(micro.stdout)
    if (micro.status !== 0) process.stdout.write(`zstd-pipe failed: ${micro.stderr.slice(-2000)}\n`)
    if (existsSync(join(arm.checkout, 'apps/server/src/sync/collection-fetch.ts')))
      child(['collections', `--checkout=${arm.checkout}`, `--db=${db}`, `--owner=${owner}`], {
        cwd: arm.checkout,
      })
    if (profiled === arm.label.toLowerCase())
      child(
        [
          'produce',
          `--checkout=${arm.checkout}`,
          `--db=${db}`,
          `--owner=${owner}`,
          '--runs=1',
          '--stacks',
        ],
        {
          cwd: arm.checkout,
        },
      )
    if (profiled === arm.label.toLowerCase()) {
      const dir = join(root, `profile-${arm.label}`)
      rmSync(dir, { recursive: true, force: true })
      child(
        ['produce', `--checkout=${arm.checkout}`, `--db=${db}`, `--owner=${owner}`, '--runs=1'],
        {
          cwd: arm.checkout,
          prefix: ['--cpu-prof', `--cpu-prof-dir=${dir}`],
        },
      )
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')))
        child(['summarize', `--profile=${join(dir, file)}`], { cwd: HARNESS })
    }
  }
}

if (import.meta.main) {
  if (command === 'seed') await seed()
  else if (command === 'produce') await produce()
  else if (command === 'collections') await collections()
  else if (command === 'summarize') summarize()
  else if (command === 'all') await all()
  else
    throw new Error('usage: first-download.ts <all|seed|produce|collections|summarize> [--flags]')
  process.exit(0)
}
