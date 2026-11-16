import { describe, expect, it } from 'vitest'
import type { HarnessHome } from './registry'
import { type HomeStopPorts, stopHome } from './stop'

const CODEX_HOME: HarnessHome = {
  homeId: 'cred_a:codex',
  credentialId: 'cred_a',
  harness: 'codex',
  dir: '/state/homes/cred_a/codex',
}
const CLAUDE_HOME: HarnessHome = {
  homeId: 'cred_a:claude-code',
  credentialId: 'cred_a',
  harness: 'claude-code',
  dir: '/state/homes/cred_a/claude-code',
}

function ports(over: Partial<HomeStopPorts> = {}) {
  const calls: string[] = []
  let processes = [
    {
      pid: 11,
      args: `${CODEX_HOME.dir}/packages/app-server-daemon/releases/x/bin/codex app-server --managed-daemon`,
    },
    {
      pid: 12,
      args: `${CODEX_HOME.dir}/packages/app-server-daemon/releases/x/bin/codex app-server daemon pid-update-loop`,
    },
    { pid: 13, args: '/usr/bin/codex app-server' },
    { pid: 14, args: `${CODEX_HOME.dir}-other/bin/codex` },
  ]
  const base: HomeStopPorts = {
    sessionsIn: (homeId) => (homeId === CODEX_HOME.homeId ? ['s1', 's2'] : ['s3']),
    stopSession: async (sessionId) => void calls.push(`stop-session:${sessionId}`),
    codexExecutable: () => '/usr/bin/codex',
    commandEnv: () => ({ PATH: '/usr/bin', CODEX_HOME: '/home/operator/.codex' }),
    run: async (command, args, env) =>
      void calls.push(`run:${command} ${args.join(' ')} CODEX_HOME=${env.CODEX_HOME}`),
    listProcesses: async () => processes,
    signal: (pid, signal) => {
      calls.push(`signal:${pid}:${signal}`)
      processes = processes.filter((process) => process.pid !== pid)
    },
    sleep: async () => undefined,
    ...over,
  }
  return { ports: base, calls }
}

describe('stopHome', () => {
  it('stops the sessions in a Codex home, then Codex’s own daemon there, and only there', async () => {
    const { ports: io, calls } = ports()
    await stopHome(CODEX_HOME, io)
    expect(calls).toEqual([
      'stop-session:s1',
      'stop-session:s2',
      `run:/usr/bin/codex app-server daemon stop CODEX_HOME=${CODEX_HOME.dir}`,
      'signal:11:SIGTERM',
      'signal:12:SIGTERM',
    ])
  })

  it('kills what survives the polite stop', async () => {
    const { ports: io, calls } = ports({
      signal: (pid, signal) => void calls.push(`signal:${pid}:${signal}`),
    })
    await stopHome(CODEX_HOME, io)
    expect(calls).toContain('signal:11:SIGKILL')
    expect(calls).toContain('signal:12:SIGKILL')
    expect(calls.some((call) => call.startsWith('signal:13'))).toBe(false)
    expect(calls.some((call) => call.startsWith('signal:14'))).toBe(false)
  })

  it('still clears the home when Codex’s stop command fails', async () => {
    const { ports: io, calls } = ports({
      run: async () => {
        throw new Error('no such subcommand')
      },
    })
    await stopHome(CODEX_HOME, io)
    expect(calls).toContain('signal:11:SIGTERM')
  })

  it('a Claude home has no daemon of its own: only its sessions stop', async () => {
    const { ports: io, calls } = ports({ listProcesses: async () => [] })
    await stopHome(CLAUDE_HOME, io)
    expect(calls).toEqual(['stop-session:s3'])
  })
})
