/**
 * First-class Podium instance identity and namespaces. [spec:SP-15aa]
 *
 * `default` is the compatibility instance: it keeps every historical path,
 * port, executable, service, and durable-session label. Named instances use
 * validated ids so the same value is safe in paths, systemd unit names, and
 * process/runtime labels.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import { instanceAbducoSocketRoots } from './abduco-socket.js'

export const DEFAULT_INSTANCE_ID = 'default'
export const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export type InstanceEnv = Readonly<Record<string, string | undefined>>

export function validateInstanceId(value: string): string {
  const id = value.trim()
  if (!INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid Podium instance id '${value}': use 1-32 lowercase letters, digits, or hyphens, starting with a letter`,
    )
  }
  return id
}

/** PODIUM_INSTANCE, else the legacy-compatible `default` identity. */
export function resolveInstanceId(env: InstanceEnv = process.env): string {
  return validateInstanceId(env.PODIUM_INSTANCE?.trim() || DEFAULT_INSTANCE_ID)
}

export interface InstanceSelection {
  instanceId: string
  argv: string[]
  /** True only when argv carried --instance (rather than env/default). */
  explicit: boolean
}

/**
 * Strip the global `--instance <id>` / `--instance=<id>` selector from argv.
 * It may appear before or after a subcommand; duplicate selectors are refused
 * so command routing can never depend on argument order.
 */
export function selectInstance(
  argv: readonly string[],
  env: InstanceEnv = process.env,
): InstanceSelection {
  let selected: string | undefined
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token === '--instance') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error('--instance requires an id')
      if (selected !== undefined) throw new Error('--instance may be specified only once')
      selected = value
      i++
      continue
    }
    if (token.startsWith('--instance=')) {
      if (selected !== undefined) throw new Error('--instance may be specified only once')
      selected = token.slice('--instance='.length)
      continue
    }
    rest.push(token)
  }
  return {
    instanceId: validateInstanceId(selected ?? env.PODIUM_INSTANCE ?? DEFAULT_INSTANCE_ID),
    argv: rest,
    explicit: selected !== undefined,
  }
}

/**
 * State root for an instance. An explicit PODIUM_STATE_DIR always wins.
 * `default` keeps ~/.podium; named instances use the XDG state tree and never
 * sit inside the default root (so default purge/update operations cannot reach them).
 */
export function instanceStateDir(
  instanceId: string = resolveInstanceId(),
  env: InstanceEnv = process.env,
  home: string = env.HOME || homedir(),
): string {
  const id = validateInstanceId(instanceId)
  if (env.PODIUM_STATE_DIR) return env.PODIUM_STATE_DIR
  if (id === DEFAULT_INSTANCE_ID) return join(home, '.podium')
  const stateHome = env.XDG_STATE_HOME || join(home, '.local', 'state')
  return join(stateHome, 'podium', id)
}

/** Default installed bundle root; PODIUM_HOME remains the runtime override. */
export function instanceInstallDir(
  instanceId: string = resolveInstanceId(),
  env: InstanceEnv = process.env,
  home: string = env.HOME || homedir(),
): string {
  const id = validateInstanceId(instanceId)
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  return id === DEFAULT_INSTANCE_ID
    ? join(dataHome, 'podium')
    : join(dataHome, 'podium-instances', id)
}

export function instanceCommandName(instanceId: string = resolveInstanceId()): string {
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? 'podium' : `podium-${id}`
}

export type InstanceServiceRole =
  | 'server'
  | 'daemon'
  | 'janitor'
  | 'update'
  | 'web'
  | 'redeploy'
  | 'health'

export function instanceServiceName(
  role: InstanceServiceRole,
  instanceId: string = resolveInstanceId(),
): string {
  const id = validateInstanceId(instanceId)
  if (id !== DEFAULT_INSTANCE_ID) return `podium-${id}-${role}.service`
  return role === 'update' ? 'podium-update-user.service' : `podium-${role}.service`
}

export function instanceUpdateTimerName(instanceId: string = resolveInstanceId()): string {
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? 'podium-update-user.timer' : `podium-${id}-update.timer`
}

/** Instance-scoped timer names used by the dev-host health supervisor. */
export function instanceTimerName(
  role: 'update' | 'health',
  instanceId: string = resolveInstanceId(),
): string {
  if (role === 'update') return instanceUpdateTimerName(instanceId)
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? 'podium-health.timer' : `podium-${id}-health.timer`
}

/**
 * The instance's resource root slice, and the sessions slice beneath it
 * (spec §6). systemd derives a slice's PARENT from its own name by cutting at
 * the last `-`, so these two names ARE the hierarchy: `podium-sessions.slice`
 * lives inside `podium.slice` without either being declared anywhere. Named
 * instances keep the same shape one level down, so two instances on one host
 * never share a budget.
 *
 * The daemon/server units deliberately stay OUTSIDE the sessions slice: the
 * supervisor must never share an OOM fate with the sessions it supervises.
 */
export function instanceSliceName(instanceId: string = resolveInstanceId()): string {
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? 'podium.slice' : `podium-${id}.slice`
}

/** Parent slice for every session (and attach) scope of one instance. */
export function instanceSessionSliceName(instanceId: string = resolveInstanceId()): string {
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? 'podium-sessions.slice' : `podium-${id}-sessions.slice`
}

/**
 * Parent slice for every development BUILD scope of one instance (POD-2472) —
 * a sibling of the sessions slice, not a member of it.
 *
 * A build placed inside the sessions slice would be bounded just as well and
 * would still be wrong: the reclaim policy reads that slice's memory pressure
 * to decide which agents to park, so every redeploy would read as agents under
 * memory pressure and park innocent sessions. The budgets and the reasoning are
 * in `scope.ts`.
 */
export function instanceBuildSliceName(instanceId: string = resolveInstanceId()): string {
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? 'podium-builds.slice' : `podium-${id}-builds.slice`
}

/** Stable durable PTY/scope identity; default keeps pre-instance labels reattachable. */
export function durableSessionLabel(
  sessionId: SessionId,
  instanceId: string = resolveInstanceId(),
): string {
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? `podium-${sessionId}` : `podium-${id}-${sessionId}`
}

/**
 * Stable endpoint triplet. Operators may override each port in config/env; the
 * derived named-instance slot is a convenient default. A rare hash collision is
 * resolved by setting explicit ports; until then the server port fails at bind
 * time, while the daemon's hook and agent-relay ports move to an ephemeral port
 * and raise a machine diagnostic rather than taking the daemon down with them
 * (POD-1229, docs/multi-instance.md).
 */
export interface InstancePorts {
  server: number
  hook: number
  agentRelay: number
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (const byte of Buffer.from(value)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function defaultInstancePorts(instanceId: string = resolveInstanceId()): InstancePorts {
  const id = validateInstanceId(instanceId)
  if (id === DEFAULT_INSTANCE_ID) return { server: 18787, hook: 45777, agentRelay: 45778 }
  // 8,000 non-overlapping triplets in the unprivileged range 20000..43999.
  const base = 20_000 + (fnv1a(id) % 8_000) * 3
  return { server: base, hook: base + 1, agentRelay: base + 2 }
}

/**
 * THE STATE-ROOT MARKER, AND WHY IT CARRIES A UUID (POD-2691, phase 1).
 *
 * `instanceId` names a CONFIGURATION — `default`, `blue`, `ci` — and it is
 * deliberately stable and human-chosen, because every path, port, service and
 * slice name is derived from it. That stability is exactly what makes it
 * useless as an OWNERSHIP token: copy a state root to another host, or restore
 * one from a backup beside the original, and two live daemons both call
 * themselves `default` while owning entirely different processes.
 *
 * `instanceUuid` is the other half: minted once per state root, never derived
 * from anything, and never reused. It answers the one question the process
 * census cannot otherwise ask — "is this stray job MINE?" — which is the
 * question a reaper must get right before it signals anything. Attribution by
 * name prefix is what produced the ghost-session incident; attribution by a
 * minted UUID cannot collide by construction.
 *
 * VERSION 1 MARKERS ARE UPGRADED IN PLACE, not rejected: every existing install
 * has one, and refusing them would make this change a migration rather than an
 * additive identity. The upgrade mints a UUID on first claim and rewrites the
 * marker; `instanceId` is untouched, so every existing consumer keeps working.
 */
export interface InstanceStateIdentityV1 {
  version: 1
  instanceId: string
}

export interface InstanceStateIdentityV2 {
  version: 2
  instanceId: string
  /** Minted once, per state root. Lowercase canonical UUID. */
  instanceUuid: string
}

/** What a marker on disk may be. Readers accept both; `ensure` upgrades. */
export type InstanceStateIdentity = InstanceStateIdentityV1 | InstanceStateIdentityV2

export const INSTANCE_MARKER_VERSION = 2

/** Canonical lowercase UUID, as `randomUUID` emits and as we refuse to guess at. */
export const INSTANCE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function validateInstanceUuid(value: string): string {
  const uuid = value.trim().toLowerCase()
  if (!INSTANCE_UUID_PATTERN.test(uuid)) {
    throw new Error(`invalid Podium instance uuid '${value}': expected a canonical lowercase UUID`)
  }
  return uuid
}

/** A fresh instance UUID. Separate from its callers so tests can pin it. */
export function mintInstanceUuid(): string {
  return randomUUID()
}

/**
 * The first 8 hex characters, for use INSIDE a computed unit name.
 *
 * Short because a systemd unit name has a length budget and a full UUID spends
 * most of it. Safe because it is never an identity on its own: the unit name it
 * appears in is COMPUTED and then EXACT-MATCHED, and the full UUID travels in
 * the job's own metadata. A `list-units` glob over this prefix is a candidate
 * filter and nothing more — matching on the prefix alone is the same mistake as
 * matching on `podium-`, one order of magnitude quieter.
 */
export function instanceUuidShort(uuid: string): string {
  return validateInstanceUuid(uuid).slice(0, 8)
}

export function instanceIdentityPath(dir: string = instanceStateDir()): string {
  return join(dir, 'instance.json')
}

/**
 * Read and validate an existing state marker; missing returns undefined.
 *
 * PURE OBSERVATION — it never mints and never writes, so a read-only consumer
 * (a census, a doctor command, a test) can ask what a root says without
 * upgrading it out from under a daemon that has not booted yet.
 */
export function readInstanceStateIdentity(
  dir: string = instanceStateDir(),
): InstanceStateIdentity | undefined {
  const path = instanceIdentityPath(dir)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`invalid Podium instance marker at ${path}: ${String(error)}`)
  }
  // Typed as the WIRE shape, not as a marker: the file is untrusted input and
  // its `version` may be any number at all, including one this build has
  // never heard of. Casting it to a known marker would narrow `version` to
  // the versions we support and make the unknown-version check below look
  // like dead code — which is exactly the check that must survive.
  const marker = parsed as { version?: unknown; instanceId?: unknown; instanceUuid?: unknown }
  if (typeof marker.instanceId !== 'string') {
    throw new Error(`invalid Podium instance marker at ${path}`)
  }
  const instanceId = validateInstanceId(marker.instanceId)
  if (marker.version === 1) return { version: 1, instanceId }
  if (marker.version === 2) {
    if (typeof marker.instanceUuid !== 'string') {
      throw new Error(`invalid Podium instance marker at ${path}: version 2 requires instanceUuid`)
    }
    return { version: 2, instanceId, instanceUuid: validateInstanceUuid(marker.instanceUuid) }
  }
  // An UNKNOWN version is a marker written by a NEWER Podium. Refusing is the
  // only safe reading: silently treating it as v1 would drop the newer fields
  // on the next write, and this file is the address of every process we own.
  throw new Error(`invalid Podium instance marker at ${path}`)
}

/** Refuse a selected id that points at another instance's state root. */
export function assertInstanceStateIdentity(
  instanceId: string = resolveInstanceId(),
  dir: string = instanceStateDir(instanceId),
): void {
  const id = validateInstanceId(instanceId)
  const marker = readInstanceStateIdentity(dir)
  if (marker && marker.instanceId !== id) {
    throw new Error(
      `Podium instance '${id}' cannot use ${dir}: it belongs to instance '${marker.instanceId}'`,
    )
  }
}

function serializeMarker(marker: InstanceStateIdentityV2): string {
  return `${JSON.stringify(marker, null, 2)}\n`
}

/**
 * Mint a UUID into a version-1 marker, atomically, with exactly one winner.
 *
 * THE RACE IS REAL AND ITS LOSING SIDE IS SILENT. Several processes claim the
 * same root at once on an ordinary boot — the CLI, the server, and the detached
 * daemon `setup --join` starts. If each minted its own UUID and wrote it, the
 * last writer would win the FILE while the others carried a UUID that is on no
 * disk anywhere; every process they went on to spawn would be stamped with an
 * id the census can never attribute, and would read as foreign — leaked rather
 * than reaped. So the mint has to have one winner, and the losers have to adopt
 * the winner's value rather than their own.
 *
 * `wx` on a sidecar elects that winner: exclusive create is atomic, so exactly
 * one process proceeds. The winner writes the finished marker into the sidecar
 * and RENAMES it over the marker, which is also atomic — there is no instant at
 * which `instance.json` is absent, truncated, or half-written, so a concurrent
 * reader sees either the old v1 or the new v2 and never a torn file. The rename
 * consumes the sidecar in the same operation, so the happy path leaves no lock
 * to clean up and no stale state to reason about.
 *
 * EXPORTED for tests only. `existing` is the caller's ALREADY-READ marker, and
 * the gap between that read and the election is the window this function has to
 * survive — passing a stale `existing` by hand is the only way to stage that
 * window deterministically. Six racing processes reproduce it about one run in
 * three, which is not a gate.
 */
export function mintUuidIntoMarker(dir: string, existing: InstanceStateIdentityV1): string {
  const path = instanceIdentityPath(dir)
  const mintPath = `${path}.mint`
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: number
    try {
      handle = openSync(mintPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // We lost the election. The winner's rename is the only thing that ends
      // this, so re-read until the marker turns v2 — and adopt ITS uuid.
      const settled = awaitMintedMarker(dir)
      if (settled) return settled.instanceUuid
      // The winner died between its exclusive create and its rename. Nothing
      // else will ever finish this mint, so break the abandoned sidecar and
      // stand for election ourselves. Bounded to one retry: a second EEXIST
      // after we removed it means another process got in first, and that one
      // is live by definition.
      try {
        unlinkSync(mintPath)
      } catch {
        // Already gone — the winner recovered, or another loser broke it first.
      }
      continue
    }
    try {
      // WINNING THE ELECTION IS NOT ENOUGH — RE-READ FIRST.
      //
      // Our caller read a version-1 marker some microseconds ago. Between that
      // read and this exclusive create, another process can have run the whole
      // mint to completion: its rename consumed the sidecar, so the slot was
      // free again and our `wx` succeeded on a BRAND NEW file. Minting here
      // would rename a second uuid over a marker that is already version 2,
      // and the process that minted first would go on holding a uuid that is
      // no longer on disk.
      //
      // Measured, not theorised: six concurrent minters released from a barrier
      // produced two different uuids until this read went in.
      const current = readInstanceStateIdentity(dir)
      if (current?.version === 2) {
        closeSync(handle)
        unlinkSync(mintPath)
        return current.instanceUuid
      }
      const marker: InstanceStateIdentityV2 = {
        version: 2,
        instanceId: existing.instanceId,
        instanceUuid: mintInstanceUuid(),
      }
      writeFileSync(handle, serializeMarker(marker))
      closeSync(handle)
      renameSync(mintPath, path)
      return marker.instanceUuid
    } catch (error) {
      try {
        closeSync(handle)
      } catch {
        // Already closed by the successful write path above.
      }
      try {
        unlinkSync(mintPath)
      } catch {
        // The rename consumed it, or it was never created.
      }
      throw error
    }
  }
  // Two elections lost in a row. Whoever holds it now is live; wait it out and
  // fail loudly rather than mint a third UUID nobody has agreed to.
  const settled = awaitMintedMarker(dir)
  if (settled) return settled.instanceUuid
  throw new Error(`could not mint an instance uuid into ${path}: the mint lock is contended`)
}

/** How long a mint loser waits for the winner's rename before treating the
 *  sidecar as abandoned. Generous against a loaded host, because the cost of
 *  being wrong here is a second UUID for one state root. */
const MINT_WAIT_MS = 2000
const MINT_POLL_MS = 25

/** Re-read the marker until the winner's rename lands, or the wait expires.
 *  Synchronous on purpose: `ensureInstanceStateIdentity` is called from
 *  process startup paths that are not async and must not become so. */
function awaitMintedMarker(dir: string): InstanceStateIdentityV2 | undefined {
  const deadline = Date.now() + MINT_WAIT_MS
  for (;;) {
    const marker = readInstanceStateIdentity(dir)
    if (marker?.version === 2) return marker
    if (Date.now() >= deadline) return undefined
    sleepSync(MINT_POLL_MS)
  }
}

/** Block this thread briefly. `ensure` is called from synchronous startup paths
 *  that cannot become async, so the wait for a racing minter has to be a real
 *  sleep — a busy spin would starve the very process we are waiting on, which on
 *  a single-core box turns the race into a two-second stall every time.
 *  `Atomics.wait` is the only sync sleep available; where the runtime has no
 *  `SharedArrayBuffer` to build one on, yielding by spin is the honest fallback. */
function sleepSync(ms: number): void {
  if (MINT_SLEEP) {
    Atomics.wait(MINT_SLEEP, 0, 0, ms)
    return
  }
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Nothing to yield to without SharedArrayBuffer.
  }
}

const MINT_SLEEP: Int32Array | undefined =
  typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : undefined

/**
 * Claim a state root before a server/daemon/config write. A named instance will
 * not silently adopt a non-empty unmarked directory; PODIUM_ADOPT_STATE=1 is the
 * explicit migration escape hatch. Existing default ~/.podium installs are
 * marked in place for backward compatibility.
 *
 * ALWAYS RETURNS VERSION 2: claiming a root is exactly the moment its UUID must
 * exist, so a version-1 marker is upgraded here rather than anywhere else.
 */
export function ensureInstanceStateIdentity(
  opts: { instanceId?: string; dir?: string; env?: InstanceEnv } = {},
): InstanceStateIdentityV2 {
  const env = opts.env ?? process.env
  const id = validateInstanceId(opts.instanceId ?? resolveInstanceId(env))
  const dir = opts.dir ?? instanceStateDir(id, env)
  const existing = readInstanceStateIdentity(dir)
  if (existing) {
    assertInstanceStateIdentity(id, dir)
    if (existing.version === 2) return existing
    return {
      version: 2,
      instanceId: existing.instanceId,
      instanceUuid: mintUuidIntoMarker(dir, existing),
    }
  }
  const entries = existsSync(dir) ? readdirSync(dir) : []
  if (entries.length > 0 && id !== DEFAULT_INSTANCE_ID && !env.PODIUM_ADOPT_STATE) {
    throw new Error(
      `refusing to adopt non-empty state directory ${dir} for instance '${id}'; choose an empty root or set PODIUM_ADOPT_STATE=1 for an intentional migration`,
    )
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const marker: InstanceStateIdentityV2 = {
    version: 2,
    instanceId: id,
    instanceUuid: mintInstanceUuid(),
  }
  try {
    writeFileSync(instanceIdentityPath(dir), serializeMarker(marker), {
      mode: 0o600,
      flag: 'wx',
    })
  } catch (error) {
    // Another process can claim the root between the read above and this exclusive
    // create (notably the detached daemon started by `setup --join`). Accept only a
    // complete marker for this exact instance; mismatches and malformed files still fail.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = readInstanceStateIdentity(dir)
    if (!raced) throw error
    assertInstanceStateIdentity(id, dir)
    // The winner may have written a version-1 marker (an older Podium racing us
    // on the same root). Its UUID still has to exist before we return.
    if (raced.version === 2) return raced
    return {
      version: 2,
      instanceId: raced.instanceId,
      instanceUuid: mintUuidIntoMarker(dir, raced),
    }
  }
  return marker
}

/**
 * Mint a FRESH uuid into a root that already has one — the copied-root remedy.
 *
 * The singleton guard refuses a second daemon on one uuid because a copied root
 * makes two machines claim the same processes. This is how an operator resolves
 * that: the copy keeps its `instanceId`, its config, its sessions and its
 * history, and gets a new owner identity.
 *
 * WHAT IT COSTS, said out loud because it is not reversible: every job the OLD
 * uuid still owns stays owned by the old uuid. Those jobs do not move and they
 * are not adopted — after a rekey they read as FOREIGN to this instance, which
 * is the census's word for "another owner's, do not touch". That is the correct
 * outcome on the machine that received the copy (those jobs belong to the
 * original, and are usually not even on this host), and it is the reason rekey
 * is an operator action rather than something a daemon does for itself on
 * finding its guard held.
 */
export function rekeyInstanceStateIdentity(
  dir: string = instanceStateDir(),
): InstanceStateIdentityV2 {
  const existing = readInstanceStateIdentity(dir)
  if (!existing) {
    throw new Error(`no Podium instance marker at ${instanceIdentityPath(dir)}: nothing to rekey`)
  }
  const marker: InstanceStateIdentityV2 = {
    version: 2,
    instanceId: existing.instanceId,
    instanceUuid: mintInstanceUuid(),
  }
  // Staged and renamed, like the mint: a reader must never catch this file
  // truncated, because it is the address of every process this root owns.
  const path = instanceIdentityPath(dir)
  const staging = `${path}.rekey.${process.pid}`
  writeFileSync(staging, serializeMarker(marker), { mode: 0o600 })
  renameSync(staging, path)
  return marker
}

/**
 * Pin named-instance durable backend sockets to private per-instance roots.
 * Explicit ABDUCO_SOCKET_DIR/TMUX_TMPDIR values are preserved as an intentional
 * sharing/configuration choice. The default instance keeps legacy global sockets.
 *
 * THE ABDUCO ROOT IS NOT UNDER THE STATE DIRECTORY, and that is the fix for
 * POD-2853 rather than an aesthetic choice. This pin used to be
 * `<state>/runtime/abduco`, which was wrong twice over:
 *
 *   - It DOUBLED the segment. abduco appends `abduco/<user>/` itself, so the
 *     composed directory was `<state>/runtime/abduco/abduco/<user>/`.
 *   - Length. Measured on a real named instance at the state root
 *     docs/multi-instance.md documents, the composed socket path was 121 bytes
 *     against a 108-byte `sun_path`, and every spawn died on abduco's
 *     "create-session: File name too long". De-duplicating the segment alone
 *     brought it to 114 — STILL over. A named instance's state root plus its
 *     instance-prefixed label simply cannot fit, so no amount of tidying the
 *     pin would have made a named instance able to start a terminal.
 *
 * See {@link instanceAbducoSocketRoot} for the budget and the ladder of roots.
 * TMUX_TMPDIR stays state-owned: tmux composes a much shorter path
 * (`<dir>/tmux-<uid>/default`) and has never been near the ceiling.
 *
 * SOCKETS MOVE for a named instance that did not set ABDUCO_SOCKET_DIR itself,
 * so masters created by an older build are not found after an upgrade and their
 * sessions have to be resumed. Every instance this pin applies to is one that
 * could not start a durable session at all, so in practice there is nothing to
 * orphan; an instance that DID set the variable is untouched.
 */
export function applyInstanceRuntimeEnv(
  instanceId: string = resolveInstanceId(),
  env: NodeJS.ProcessEnv = process.env,
  dir: string = instanceStateDir(instanceId, env),
): NodeJS.ProcessEnv {
  const id = validateInstanceId(instanceId)
  env.PODIUM_INSTANCE = id
  if (id === DEFAULT_INSTANCE_ID) return env
  if (!env.ABDUCO_SOCKET_DIR) {
    // The first root that both fits and can actually be created. CREATION IS
    // NOT A FORMALITY here the way it was under the state directory: an
    // XDG_RUNTIME_DIR inherited from another uid, or a read-only runtime
    // directory, would otherwise throw out of instance bootstrap and take the
    // daemon down before it served anything — a worse outcome than a socket
    // root with less isolation. The last candidate is used unconditionally so
    // the variable is always pinned and abduco's own fall-through never gets to
    // pick a root behind Podium's back.
    const roots = instanceAbducoSocketRoots(id, env)
    for (const root of roots) {
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 })
        env.ABDUCO_SOCKET_DIR = root
        break
      } catch {
        // Not creatable — try the next one down the ladder.
      }
    }
    env.ABDUCO_SOCKET_DIR ??= roots[roots.length - 1]
  }
  if (!env.TMUX_TMPDIR) {
    env.TMUX_TMPDIR = join(dir, 'runtime', 'tmux')
    mkdirSync(env.TMUX_TMPDIR, { recursive: true, mode: 0o700 })
  }
  return env
}
