import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import type { AgentMemoryWire, ProjectMemoryWire } from '@podium/protocol'

/** One process as seen in /proc. memBytes is PSS where readable, RSS otherwise. */
export interface ProcSample {
  pid: number
  ppid: number
  name: string
  cmdline: string
  /** Absent when the cwd link isn't readable (other users' processes). */
  cwd?: string
  memBytes: number
}

/** How to find a session's processes: its attach/PTY pid, and the durable label
 *  that the abduco/tmux master (not a daemon child!) carries in its cmdline. */
export interface SessionProcessHint {
  sessionId: string
  label: string
  pid?: number
}

export interface MemoryAttribution {
  agents: AgentMemoryWire[]
  projects: ProjectMemoryWire[]
}

const PAGE_SIZE = 4096
const TOP_PROCESSES = 3

function pssBytes(pid: number): number | undefined {
  // smaps_rollup (same-user readable) gives PSS: shared pages divided fairly
  // across their users — the honest per-process attribution number.
  try {
    const m = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+) kB$/m)
    if (m) return Number(m[1]) * 1024
  } catch {
    // fall through to RSS
  }
  return undefined
}

function rssBytes(pid: number): number | undefined {
  try {
    const resident = readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]
    return resident === undefined ? undefined : Number(resident) * PAGE_SIZE
  } catch {
    return undefined
  }
}

/** Walk /proc once. Processes that vanish mid-walk are skipped, never thrown on. */
export function snapshotProcesses(procRoot = '/proc'): ProcSample[] {
  const out: ProcSample[] = []
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    try {
      const stat = readFileSync(`${procRoot}/${entry}/stat`, 'utf8')
      // `pid (comm) state ppid ...` — comm may contain spaces/parens; split at the LAST ')'.
      const close = stat.lastIndexOf(')')
      const name = stat.slice(stat.indexOf('(') + 1, close)
      const ppid = Number(stat.slice(close + 2).split(' ')[1])
      let cmdline = ''
      try {
        cmdline = readFileSync(`${procRoot}/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
      } catch {
        // kernel threads etc. — keep the empty cmdline
      }
      let cwd: string | undefined
      try {
        cwd = readlinkSync(`${procRoot}/${entry}/cwd`)
      } catch {
        // other users' processes: cwd unreadable → never attributed to a project
      }
      const memBytes = pssBytes(pid) ?? rssBytes(pid)
      if (memBytes === undefined) continue
      out.push({ pid, ppid, name, cmdline, ...(cwd === undefined ? {} : { cwd }), memBytes })
    } catch {
      // the process exited between readdir and the reads
    }
  }
  return out
}

const underRoot = (cwd: string, root: string): boolean => cwd === root || cwd.startsWith(`${root}/`)

/**
 * Split a process snapshot into agent sessions, controlled project roots, and the
 * implicit rest. Agent claims win: a session's whole process subtree is taken first
 * (found via its pid and via the durable label in master cmdlines), so a dev server
 * an agent spawned counts as that agent's, never double-counted under its project.
 */
export function attributeMemory(
  procs: ProcSample[],
  sessions: SessionProcessHint[],
  roots: string[],
  opts: { selfPid?: number } = {},
): MemoryAttribution {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const children = new Map<number, number[]>()
  for (const p of procs) {
    const list = children.get(p.ppid)
    if (list) list.push(p.pid)
    else children.set(p.ppid, [p.pid])
  }
  const subtree = (pid: number, into: Set<number>): void => {
    if (!byPid.has(pid) || into.has(pid)) return
    into.add(pid)
    for (const child of children.get(pid) ?? []) subtree(child, into)
  }

  const claimed = new Set<number>()
  const agents: AgentMemoryWire[] = []
  for (const session of sessions) {
    const mine = new Set<number>()
    if (session.pid !== undefined) subtree(session.pid, mine)
    for (const p of procs) {
      if (p.cmdline.includes(session.label)) subtree(p.pid, mine)
    }
    if (mine.size === 0) continue
    let bytes = 0
    for (const pid of mine) {
      bytes += byPid.get(pid)?.memBytes ?? 0
      claimed.add(pid)
    }
    agents.push({ sessionId: session.sessionId, bytes, processCount: mine.size })
  }

  // Longest root first so a worktree registered inside a repo wins over the repo.
  const rootsByLength = [...roots].sort((a, b) => b.length - a.length)
  const byRoot = new Map<string, ProcSample[]>()
  for (const p of procs) {
    if (claimed.has(p.pid) || p.pid === opts.selfPid || p.cwd === undefined) continue
    const root = rootsByLength.find((r) => underRoot(p.cwd as string, r))
    if (root === undefined) continue
    const list = byRoot.get(root)
    if (list) list.push(p)
    else byRoot.set(root, [p])
  }
  const projects: ProjectMemoryWire[] = [...byRoot.entries()].map(([root, list]) => {
    const byName = new Map<string, number>()
    for (const p of list) byName.set(p.name, (byName.get(p.name) ?? 0) + p.memBytes)
    return {
      root,
      bytes: list.reduce((sum, p) => sum + p.memBytes, 0),
      processCount: list.length,
      topProcesses: [...byName.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_PROCESSES)
        .map(([name, bytes]) => ({ name, bytes })),
    }
  })

  agents.sort((a, b) => b.bytes - a.bytes)
  projects.sort((a, b) => b.bytes - a.bytes)
  return { agents, projects }
}
