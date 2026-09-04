// apps/daemon/src/claude-sdk-protocol.test.ts
//
// How the SDK host gets launched, pinned per runtime. This is the part of the
// split with no type system behind it: an argv list handed to `spawn`. Each
// branch below has a real failure attached to it.

import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SDK_HOST_ENTRY,
  CLAUDE_SDK_HOST_ENV,
  claudeSdkHostLaunch,
  isCompiledBunfsUrl,
} from './claude-sdk-protocol.js'

describe('launching the Claude SDK host', () => {
  it('re-execs the standalone binary with the sentinel when compiled', () => {
    // One binary ships, so there is no .ts on disk to hand a child. The binary
    // becomes the host; scripts/cli-compiled.ts reads the sentinel and dispatches.
    const launch = claudeSdkHostLaunch('file:///$bunfs/root/podium')
    expect(launch.cmd).toBe(process.execPath)
    expect(launch.args).toEqual([])
    expect(launch.env[CLAUDE_SDK_HOST_ENV]).toBe('1')
  })

  it('recognises the compiled root on Windows too, where it is not /$bunfs', () => {
    // Checking only '/$bunfs/' made the compiled Windows daemon take the
    // run-from-source branch and crash-loop — the same trap discovery-worker-embed
    // documents, and the reason that spelling is shared rather than re-derived.
    expect(isCompiledBunfsUrl('file:///B:/%7EBUN/root/podium.exe')).toBe(true)
    expect(isCompiledBunfsUrl('B:\\~BUN\\root\\podium.exe')).toBe(true)
    expect(isCompiledBunfsUrl('file:///home/me/apps/daemon/src/x.ts')).toBe(false)
  })

  it('carries the sentinel on the from-source launch as well', () => {
    // Not decoration: the host module uses it to tell "launched as a host" from
    // "imported by a unit test", and only the first may start a stdin loop.
    const launch = claudeSdkHostLaunch(import.meta.url)
    expect(launch.env[CLAUDE_SDK_HOST_ENV]).toBe('1')
    expect(launch.args.at(-1)).toMatch(/claude-sdk-host\.ts$/)
  })

  it('always gives the child a way to load TypeScript', () => {
    // The bug this caught for real: a vitest worker's execArgv carries no loader,
    // so replaying it produced a child that found claude-sdk-host.ts and then died
    // on the first './x.js' specifier inside it. Whatever the runtime, the argv
    // must contain something that can load TypeScript.
    const launch = claudeSdkHostLaunch(import.meta.url)
    const loaded =
      Boolean(process.versions.bun) ||
      launch.args.some((a) => a.includes('tsx')) ||
      launch.args.some((a) => a.includes('strip-types'))
    expect(loaded, `argv cannot load TypeScript: ${launch.args.join(' ')}`).toBe(true)
  })

  it('points at a host entry that is really there', () => {
    // The compiled build and the from-source spawn must name the same file; a
    // stale constant here is a crash-loop in production and nothing in CI.
    expect(CLAUDE_SDK_HOST_ENTRY).toBe('apps/daemon/src/claude-sdk-host.ts')
    const launch = claudeSdkHostLaunch(import.meta.url)
    expect(launch.args.at(-1)).toContain(CLAUDE_SDK_HOST_ENTRY.replace('apps/daemon/src/', ''))
  })
})
