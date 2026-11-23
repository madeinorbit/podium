import { spawnSync } from 'node:child_process'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { testHarnessContext } from '../../driver/testing/harness-context.js'
import { antigravityInstrumentation } from './instrumentation.js'

describe.skipIf(process.platform === 'win32')('Antigravity hook fail-open behavior', () => {
  it('preserves native permission policy when curl is absent or the daemon is down', async () => {
    const install = await antigravityInstrumentation.install({
      sessionId: asSessionId('session-a'),
      endpointUrl: 'http://127.0.0.1:9/hooks/test',
      settingsDir: '/tmp/podium-antigravity-hooks',
      harnessContext: testHarnessContext({ kind: 'antigravity' }),
    })
    if (!install.file) throw new Error('Hook configuration is missing')
    const doc = JSON.parse(install.file.contents)
    const command = doc['podium-observer'].PreToolUse[0].hooks[0].command
    for (const path of ['/no-curl-on-this-path', '/usr/bin:/bin']) {
      const result = spawnSync('/bin/sh', ['-c', command], {
        input: '{"hookEventName":"PreToolUse"}',
        env: { PATH: path },
        encoding: 'utf8',
        timeout: 5_000,
      })
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ decision: 'allow' })
    }
  })
})
