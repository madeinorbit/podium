import { describe, expect, it } from 'vitest'
import { attributeMemory, type ProcSample, snapshotProcesses } from './memory-breakdown'

const MB = 1024 * 1024
const proc = (p: Partial<ProcSample> & { pid: number }): ProcSample => ({
  ppid: 1,
  name: 'proc',
  cmdline: '',
  memBytes: 1 * MB,
  ...p,
})

describe('attributeMemory', () => {
  it('claims a session by pid including its whole subtree', () => {
    const procs = [
      proc({ pid: 10, name: 'claude', memBytes: 100 * MB }),
      proc({ pid: 11, ppid: 10, name: 'node', memBytes: 50 * MB }),
      proc({ pid: 12, ppid: 11, name: 'rg', memBytes: 5 * MB }),
      proc({ pid: 99, name: 'firefox', memBytes: 900 * MB }),
    ]
    const { agents } = attributeMemory(
      procs,
      [{ sessionId: 's1', label: 'podium-s1', pid: 10 }],
      [],
    )
    expect(agents).toEqual([{ sessionId: 's1', bytes: 155 * MB, processCount: 3 }])
  })

  it('claims the durable master found by label in the cmdline (abduco/tmux)', () => {
    const procs = [
      // attach client under the daemon
      proc({ pid: 20, name: 'abduco', cmdline: 'abduco -a podium-s1', memBytes: 1 * MB }),
      // detached master holding the real agent — NOT a daemon child
      proc({ pid: 30, name: 'abduco', cmdline: 'abduco -c podium-s1 claude', memBytes: 1 * MB }),
      proc({ pid: 31, ppid: 30, name: 'claude', memBytes: 200 * MB }),
    ]
    const { agents } = attributeMemory(
      procs,
      [{ sessionId: 's1', label: 'podium-s1', pid: 20 }],
      [],
    )
    expect(agents[0]?.bytes).toBe(202 * MB)
    expect(agents[0]?.processCount).toBe(3)
  })

  it('attributes unclaimed processes to the longest matching root by cwd', () => {
    const procs = [
      proc({ pid: 40, name: 'node', cwd: '/src/app', memBytes: 300 * MB }),
      proc({ pid: 41, name: 'esbuild', cwd: '/src/app/web', memBytes: 50 * MB }),
      proc({ pid: 42, name: 'node', cwd: '/src/app-other', memBytes: 70 * MB }), // prefix trap
      proc({ pid: 43, name: 'vim', cwd: '/etc', memBytes: 10 * MB }),
    ]
    const { projects } = attributeMemory(procs, [], ['/src/app'])
    expect(projects).toEqual([
      {
        root: '/src/app',
        bytes: 350 * MB,
        processCount: 2,
        topProcesses: [
          { name: 'node', bytes: 300 * MB },
          { name: 'esbuild', bytes: 50 * MB },
        ],
      },
    ])
  })

  it('never counts a process twice: agent subtrees win over cwd matching', () => {
    const procs = [
      proc({ pid: 10, name: 'claude', cwd: '/src/app', memBytes: 100 * MB }),
      proc({ pid: 11, ppid: 10, name: 'node', cwd: '/src/app', memBytes: 40 * MB }),
    ]
    const { agents, projects } = attributeMemory(
      procs,
      [{ sessionId: 's1', label: 'podium-s1', pid: 10 }],
      ['/src/app'],
    )
    expect(agents[0]?.bytes).toBe(140 * MB)
    expect(projects).toEqual([])
  })

  it('excludes the daemon itself and aggregates topProcesses by name', () => {
    const procs = [
      proc({ pid: 1000, name: 'node', cwd: '/src/app', memBytes: 30 * MB }), // the daemon
      proc({ pid: 50, name: 'node', cwd: '/src/app', memBytes: 10 * MB }),
      proc({ pid: 51, name: 'node', cwd: '/src/app', memBytes: 20 * MB }),
      proc({ pid: 52, name: 'postgres', cwd: '/src/app', memBytes: 5 * MB }),
    ]
    const { projects } = attributeMemory(procs, [], ['/src/app'], { selfPid: 1000 })
    expect(projects[0]?.bytes).toBe(35 * MB)
    expect(projects[0]?.topProcesses[0]).toEqual({ name: 'node', bytes: 30 * MB })
  })

  it('drops empty groups and sorts agents/projects by size descending', () => {
    const procs = [
      proc({ pid: 10, name: 'a', memBytes: 1 * MB }),
      proc({ pid: 20, name: 'b', memBytes: 9 * MB }),
      proc({ pid: 60, name: 'x', cwd: '/p/one', memBytes: 2 * MB }),
      proc({ pid: 61, name: 'y', cwd: '/p/two', memBytes: 8 * MB }),
    ]
    const { agents, projects } = attributeMemory(
      procs,
      [
        { sessionId: 'small', label: 'podium-small', pid: 10 },
        { sessionId: 'big', label: 'podium-big', pid: 20 },
        { sessionId: 'gone', label: 'podium-gone', pid: 999 }, // no live process
      ],
      ['/p/one', '/p/two', '/p/empty'],
    )
    expect(agents.map((a) => a.sessionId)).toEqual(['big', 'small'])
    expect(projects.map((p) => p.root)).toEqual(['/p/two', '/p/one'])
  })
})

describe('snapshotProcesses', () => {
  it.runIf(process.platform === 'linux')('sees this very test process with memory', () => {
    const procs = snapshotProcesses()
    const self = procs.find((p) => p.pid === process.pid)
    expect(self).toBeDefined()
    expect(self?.memBytes).toBeGreaterThan(0)
    expect(self?.cwd).toBe(process.cwd())
    expect(self?.ppid).toBe(process.ppid)
  })
})
