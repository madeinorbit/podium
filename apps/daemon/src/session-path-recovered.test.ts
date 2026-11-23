// A SESSION CHILD'S PATH IS THE RECOVERED COMMAND ENV'S, never the daemon's own
// (POD-6535; the symptom in docs/design/harness-access-contract.md §1: "Engine
// children get the GUI app's PATH, not the recovered one").
//
// Every session's Podium env carries the browser shim, and the shim used to
// spell PATH as `<shim dir>:<the daemon's process.env.PATH>`. Applied after the
// context's env, that replaced the recovered PATH with a GUI-launched daemon's
// bare one in every terminal, engine and headless child. The shim's folder is
// a prefix; the PATH behind it is the account context's.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testHarnessContext } from '@podium/harness/driver/testing'
import { asSessionId } from '@podium/model'
import { afterAll, expect, it } from 'vitest'
import { sessionProcessEnv } from './control/session.js'
import { engineEnvBuilder } from './runtime/host.js'

const settingsDir = mkdtempSync(join(tmpdir(), 'podium-session-path-'))
afterAll(() => rmSync(settingsDir, { recursive: true, force: true }))

it('an engine child runs on the recovered PATH, with the browser shim ahead of it', () => {
  const ctx = {
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
    instanceId: 'default',
    instanceUuid: 'uuid',
    settingsDir,
  }
  const previous = process.env.PATH
  process.env.PATH = '/gui-app/bin'
  let path: string[]
  try {
    const env = engineEnvBuilder((sessionId, agentKind) =>
      sessionProcessEnv(ctx, sessionId, agentKind),
    )({
      sessionId: asSessionId('recovered-path'),
      agentKind: 'codex',
      harnessContext: testHarnessContext({
        kind: 'codex',
        env: { PATH: '/recovered/bin:/usr/bin' },
      }),
    })
    path = (env.PATH ?? '').split(':')
  } finally {
    process.env.PATH = previous
  }
  expect(path).toContain('/recovered/bin')
  expect(path).not.toContain('/gui-app/bin')
  expect(path.indexOf(join(settingsDir, 'browser-shims'))).toBeLessThan(
    path.indexOf('/recovered/bin'),
  )
})
