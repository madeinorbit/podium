import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { HostToolName, HostTools } from '../../host-tools.js'
import type { HarnessObserveInput } from '../../manifest.js'
import { isInteractiveCodexSource } from './discovery.js'

const MAX_PROCESSES = 16
const MAX_ROLLOUT_FILES = 64
const INSPECTION_MS = 3_000
const OUTPUT_BYTES = 512 * 1024
const HEADER_BYTES = 64 * 1024
const START_SLOP_MS = 2_000

export interface OwnedCodexRollout {
  id: string
  path: string
  createdMs: number
}

export type ProcessInspection = (
  command: HostToolName,
  args: string[],
  limits: { timeout: number; maxBuffer: number },
) => Promise<string>

/** pgrep/lsof/ps through the OS-tool port: absolute paths from the session's
 *  command environment, never the daemon's PATH (POD-6536). */
export const hostProcessInspection =
  (tools: HostTools): ProcessInspection =>
  (command, args, limits) =>
    new Promise((done, reject) => {
      tools.execFile(
        command,
        args,
        { ...limits, env: { LC_ALL: 'C', TZ: 'UTC' } },
        (err, stdout, stderr) => {
          // pgrep/lsof use 1 for an empty result. Diagnostics (including permission
          // failures) are never evidence, even when the exit code happens to be 1.
          if (err && !(err.code === 1 && !stdout && !stderr)) reject(err)
          else if (stderr) reject(new Error(`${command} reported an inspection failure`))
          else done(stdout)
        },
      )
    })

interface ProcessIdentity {
  pid: number
  parent: number
  started: string
}

/** macOS has no /proc/<pid>/fd. Inspect only the live PTY child and a bounded
 * owned lineage (the npm launcher can remain a Node wrapper). No environments,
 * cwd guesses, or model-visible markers participate in identity. Each resolver
 * belongs to one observer life; it never shares evidence across attachments. */
export function createOwnedCodexRolloutResolver(input: {
  ownedProcess: NonNullable<HarnessObserveInput['ownedProcess']>
  sessionsRoot: string
  startedAtMs?: number
  resumeValue?: string
  platform?: NodeJS.Platform
  /** How to run pgrep/lsof/ps: {@link hostProcessInspection} over the
   *  session's {@link HostTools} (production), or a test's script. */
  inspect: ProcessInspection
}): () => Promise<OwnedCodexRollout | undefined> {
  const inspect = input.inspect
  let anchor: { owner: object; identity: ProcessIdentity } | undefined
  return async () => {
    if ((input.platform ?? process.platform) !== 'darwin') return undefined
    const owner = input.ownedProcess()
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return undefined
    const current = () => {
      const live = input.ownedProcess()
      return live?.pid === owner.pid && live.generation === owner.generation
    }
    const deadline = Date.now() + INSPECTION_MS
    const run = async (command: HostToolName, args: string[], maxBuffer = OUTPUT_BYTES) => {
      if (!current() || Date.now() >= deadline) throw new Error('owned process inspection expired')
      const result = await inspect(command, args, {
        timeout: Math.min(1_000, deadline - Date.now()),
        maxBuffer,
      })
      if (!current() || Date.now() >= deadline || Buffer.byteLength(result) > maxBuffer)
        throw new Error('owned process inspection expired')
      return result
    }
    const identities = async (pids: number[]): Promise<ProcessIdentity[]> => {
      const output = await run('ps', ['-p', pids.join(','), '-o', 'pid=,ppid=,lstart='], 16 * 1024)
      const rows = output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
          const started = match?.[3]
          if (!match || !started || !Number.isFinite(Date.parse(`${started} UTC`)))
            throw new Error('invalid process identity')
          return { pid: Number(match[1]), parent: Number(match[2]), started }
        })
      if (
        rows.length !== pids.length ||
        new Set(rows.map((row) => row.pid)).size !== pids.length ||
        rows.some((row) => !pids.includes(row.pid))
      )
        throw new Error('owned process exited')
      return rows
    }
    const openFiles = async (pids: number[]): Promise<Set<string>> => {
      const output = await run('lsof', ['-nP', '-a', '-p', pids.join(','), '-F0pfn'])
      let pid: number | undefined
      let file = false
      const paths = new Set<string>()
      for (const raw of output.split('\0')) {
        const field = raw.replace(/^\n+/, '')
        if (!field) continue
        if (field[0] === 'p') {
          pid = Number(field.slice(1))
          if (!pids.includes(pid)) throw new Error('foreign process in open files')
          file = false
        } else if (field[0] === 'f') {
          file = true
        } else if (field[0] === 'n' && pid && file) {
          const path = field.slice(1)
          if (isAbsolute(path) && path.endsWith('.jsonl')) paths.add(path)
        }
      }
      return paths
    }
    try {
      const [rootProcess] = await identities([owner.pid])
      if (!rootProcess) return undefined
      if (
        anchor?.owner === owner.generation &&
        (anchor.identity.pid !== rootProcess.pid || anchor.identity.started !== rootProcess.started)
      )
        return undefined
      if (
        input.startedAtMs !== undefined &&
        // ps runs under TZ=UTC, but lstart omits the zone. Parsing it as the
        // daemon's local time rejects every fresh process east of Greenwich.
        Date.parse(`${rootProcess.started} UTC`) < input.startedAtMs - START_SLOP_MS
      )
        return undefined
      anchor = { owner: owner.generation, identity: rootProcess }
      const tree = [rootProcess]
      // Query children of known parents, never an unbounded process listing.
      for (let i = 0; i < tree.length; i++) {
        const parent = tree[i]
        if (!parent) return undefined
        const children = (await run('pgrep', ['-P', String(parent.pid)], 4 * 1024)).trim()
        if (!children) continue
        if (!/^\d+(?:\s+\d+)*$/.test(children)) return undefined
        const pids = children.split(/\s+/).map(Number)
        if (tree.length + pids.length > MAX_PROCESSES) return undefined
        const rows = await identities(pids)
        if (
          rows.some(
            (row) => row.parent !== parent.pid || tree.some((prior) => prior.pid === row.pid),
          )
        )
          return undefined
        tree.push(...rows)
      }
      const pids = tree.map((row) => row.pid)
      const paths = await openFiles(pids)
      if (paths.size > MAX_ROLLOUT_FILES) return undefined
      const root = await realpath(input.sessionsRoot)
      const candidates = new Map<string, OwnedCodexRollout>()
      for (const path of paths) {
        if (!current() || Date.now() >= deadline) return undefined
        const rel = relative(root, resolve(path))
        if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) continue
        const canonical = await realpath(path)
        const canonicalRel = relative(root, canonical)
        if (
          !canonicalRel ||
          canonicalRel === '..' ||
          canonicalRel.startsWith('../') ||
          isAbsolute(canonicalRel)
        )
          continue
        const handle = await open(canonical, 'r')
        try {
          if (!(await handle.stat()).isFile()) continue
          const buffer = Buffer.alloc(HEADER_BYTES)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          const end = buffer.indexOf(10, 0)
          if (end < 0 || end >= bytesRead) continue
          const meta: unknown = JSON.parse(buffer.toString('utf8', 0, end))
          if (
            !meta ||
            typeof meta !== 'object' ||
            !('type' in meta) ||
            meta.type !== 'session_meta' ||
            !('payload' in meta) ||
            !meta.payload ||
            typeof meta.payload !== 'object'
          )
            continue
          const payload = meta.payload as Record<string, unknown>
          if (
            typeof payload.id !== 'string' ||
            !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(payload.id) ||
            !isInteractiveCodexSource(payload.source)
          )
            continue
          const timestamp = payload.timestamp ?? ('timestamp' in meta ? meta.timestamp : undefined)
          const createdMs = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
          if (!Number.isFinite(createdMs)) continue
          if (
            payload.id !== input.resumeValue &&
            input.startedAtMs !== undefined &&
            createdMs < input.startedAtMs - START_SLOP_MS
          )
            continue
          candidates.set(canonical, { id: payload.id, path: canonical, createdMs })
        } catch {
          // A torn/malformed header is not evidence. Lazy creation retries later.
        } finally {
          await handle.close()
        }
      }
      if (candidates.size !== 1) return undefined
      const [candidate] = candidates.values()
      // Fence the async file work with the same OS lifetimes/parent edges AND
      // a second open-file observation. PID reuse, exit and rotation fail closed.
      const stillOpen = await openFiles(pids)
      if (paths.size !== stillOpen.size || [...paths].some((path) => !stillOpen.has(path)))
        return undefined
      const after = await identities(pids)
      if (
        tree.some(
          (prior) =>
            !after.some(
              (row) =>
                row.pid === prior.pid &&
                row.parent === prior.parent &&
                row.started === prior.started,
            ),
        )
      )
        return undefined
      if (!candidate || !paths.has(candidate.path) || !stillOpen.has(candidate.path) || !current())
        return undefined
      return candidate
    } catch {
      // Missing tools, permission denial, timeout, or an exited wrapper: retain
      // the observer's unbound diagnostic and retry on its slow recovery cadence.
      return undefined
    }
  }
}
