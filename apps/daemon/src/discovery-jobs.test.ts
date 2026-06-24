import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMemoryBreakdownJob } from './discovery-jobs.js'

function fakeProc(root: string, pid: number, ppid: number, comm: string, cmdline: string, rssPages: number) {
  const d = join(root, String(pid))
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'stat'), `${pid} (${comm}) S ${ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`)
  writeFileSync(join(d, 'statm'), `1000 ${rssPages} 0 0 0 0 0`)
  writeFileSync(join(d, 'cmdline'), cmdline.replaceAll(' ', '\0'))
}

describe('runMemoryBreakdownJob', () => {
  it('attributes a labelled process subtree to its session', () => {
    const root = mkdtempSync(join(tmpdir(), 'proc-'))
    fakeProc(root, 100, 1, 'abduco', 'abduco -n podium-S1 claude', 50)
    fakeProc(root, 101, 100, 'claude', 'claude --foo', 200)
    const out = runMemoryBreakdownJob({
      sessions: [{ sessionId: 'S1', label: 'podium-S1', pid: 100 }],
      roots: [], selfPid: 999, procRoot: root,
    })
    const agent = out.agents.find((a) => a.sessionId === 'S1')
    expect(agent).toBeTruthy()
    expect(agent!.processCount).toBe(2)
  })
})
