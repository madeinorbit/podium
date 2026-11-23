// THE VENDOR'S SIGN-OUT IN A HOME (credential management §8 cleanup; epic plan
// Task 9, acceptance 6). A fake harness stands in for the real CLIs: a script
// that records the arguments and the directory variable it was started with.
// No real sign-out runs here, and the server keeps the switch off.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonContext } from '../control/context'
import { homeHandlers } from '../control/homes'
import { testHarnessSnapshot } from '../test-support/harness-snapshot'
import { HomeRegistry } from './registry'
import { signOutOfHome } from './sign-out'

const CRED = 'cred_dddddddd-0000-4000-8000-0000000000b1'

let root: string
let log: string
let sent: DaemonMessage[]

/** A fake `claude` / `codex`: logs its argv and home variables, exits `code`. */
function fakeHarness(name: string, code = 0): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const path = join(bin, name)
  writeFileSync(
    path,
    `#!/bin/sh\necho "args=$* claude=$CLAUDE_CONFIG_DIR codex=$CODEX_HOME" >> "${log}"\nexit ${code}\n`,
  )
  chmodSync(path, 0o755)
  return path
}

function context(homes: HomeRegistry, paths: Record<string, string>): DaemonContext {
  const snapshot = testHarnessSnapshot(paths)
  return {
    send: (frame: DaemonMessage) => void sent.push(frame),
    homeDir: join(root, 'person'),
    homes,
    harnessRuntime: { current: async () => snapshot, isCurrent: () => true },
  } as unknown as DaemonContext
}

async function reply(type: 'homeRemoveResult') {
  const start = Date.now()
  for (;;) {
    const frame = sent.find((candidate) => candidate.type === type)
    if (frame) return frame
    if (Date.now() - start > 10_000) throw new Error(`no ${type}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const logged = (): string => (existsSync(log) ? readFileSync(log, 'utf8') : '')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-home-signout-'))
  mkdirSync(join(root, 'person'))
  log = join(root, 'harness.log')
  sent = []
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('signOutOfHome', () => {
  it("runs the harness's own sign-out with its directory variable on the home", async () => {
    const homes = new HomeRegistry({ root: join(root, 'homes') })
    const claude = (await homes.ensure(CRED, 'claude-code')).home
    const codex = (await homes.ensure(CRED, 'codex')).home
    const ctx = context(homes, {
      'claude-code': fakeHarness('claude'),
      codex: fakeHarness('codex'),
    })
    expect(await signOutOfHome(ctx, claude)).toEqual({ ok: true })
    expect(await signOutOfHome(ctx, codex)).toEqual({ ok: true })
    const lines = logged().trim().split('\n')
    expect(lines[0]).toContain('args=auth logout')
    expect(lines[0]).toContain(`claude=${claude.dir}`)
    expect(lines[1]).toContain('args=logout')
    expect(lines[1]).toContain(`codex=${codex.dir}`)
  })

  it('reports a sign-out that failed, without throwing', async () => {
    const homes = new HomeRegistry({ root: join(root, 'homes') })
    const home = (await homes.ensure(CRED, 'claude-code')).home
    const ctx = context(homes, { 'claude-code': fakeHarness('claude', 3) })
    expect(await signOutOfHome(ctx, home)).toMatchObject({ ok: false })
  })
})

describe('homeRemoveRequest with signOut', () => {
  it('signs out in the home, then deletes it', async () => {
    const homes = new HomeRegistry({ root: join(root, 'homes') })
    const home = (await homes.ensure(CRED, 'claude-code')).home
    const ctx = context(homes, { 'claude-code': fakeHarness('claude') })
    homeHandlers.homeRemoveRequest(ctx, {
      type: 'homeRemoveRequest',
      requestId: 'r1',
      homeId: home.homeId,
      signOut: true,
    })
    expect(await reply('homeRemoveResult')).toMatchObject({ ok: true, removed: true })
    expect(logged()).toContain(`args=auth logout claude=${home.dir}`)
    expect(existsSync(home.dir)).toBe(false)
  })

  it('without signOut deletes the home and runs nothing', async () => {
    const homes = new HomeRegistry({ root: join(root, 'homes') })
    const home = (await homes.ensure(CRED, 'claude-code')).home
    const ctx = context(homes, { 'claude-code': fakeHarness('claude') })
    homeHandlers.homeRemoveRequest(ctx, {
      type: 'homeRemoveRequest',
      requestId: 'r2',
      homeId: home.homeId,
    })
    expect(await reply('homeRemoveResult')).toMatchObject({ ok: true, removed: true })
    expect(logged()).toBe('')
    expect(existsSync(home.dir)).toBe(false)
  })

  it('a failed sign-out still removes the home', async () => {
    const homes = new HomeRegistry({ root: join(root, 'homes') })
    const home = (await homes.ensure(CRED, 'claude-code')).home
    const ctx = context(homes, { 'claude-code': fakeHarness('claude', 1) })
    homeHandlers.homeRemoveRequest(ctx, {
      type: 'homeRemoveRequest',
      requestId: 'r3',
      homeId: home.homeId,
      signOut: true,
    })
    expect(await reply('homeRemoveResult')).toMatchObject({ ok: true, removed: true })
    expect(logged()).toContain('args=auth logout')
    expect(existsSync(home.dir)).toBe(false)
  })
})
