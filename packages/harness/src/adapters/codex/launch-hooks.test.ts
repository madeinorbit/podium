import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withHarnessHome } from '../../harness-context.js'
import type { HarnessContext } from '../../harness-context-types.js'
import { codexHookLaunchFlags, codexInstrumentation } from './instrumentation.js'

let root: string
let home: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-codex-launch-hooks-'))
  home = join(root, 'homes', 'cred_a', 'codex')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function context(): HarnessContext {
  const base: HarnessContext = {
    installation: {
      kind: 'codex',
      executable: '/usr/bin/codex',
      version: 'codex-cli 0.169.0',
      generation: 1,
    },
    home: join(root, 'person'),
    env: { HOME: join(root, 'person'), CODEX_HOME: join(root, 'person', '.codex') },
    roots: { state: join(root, 'person', '.codex') } as HarnessContext['roots'],
  }
  return withHarnessHome(base, { id: 'cred_a:codex', dir: home })
}

const destination = (launchHookTrust?: () => Promise<Record<string, string> | undefined>) => ({
  sessionId: 's1' as SessionId,
  endpointUrl: 'http://127.0.0.1:1/hooks/s1',
  settingsDir: join(root, 'settings'),
  harnessContext: context(),
  ...(launchHookTrust ? { launchHookTrust } : {}),
})

describe('Codex hooks in a Podium home', () => {
  it('ride the launch as -c flags with Codex’s trust, and nothing is written in the home', async () => {
    let asked: readonly string[] = []
    const result = await codexInstrumentation.install({
      ...destination(),
      launchHookTrust: async (_installation, flags) => {
        asked = flags
        return { '/<session-flags>/config.toml:session_start:0:0': 'sha256:aaa' }
      },
    })
    expect(asked).toEqual(codexHookLaunchFlags())
    expect(result.degradedReason).toBeUndefined()
    expect(result.args).toEqual([
      ...codexHookLaunchFlags(),
      '-c',
      'hooks.state={"/<session-flags>/config.toml:session_start:0:0"={trusted_hash="sha256:aaa"}}',
    ])
    expect(result.env?.PODIUM_CODEX_HOOK_URL).toBe('http://127.0.0.1:1/hooks/s1')
    expect(existsSync(home) ? readdirSync(home) : []).toEqual([])
    expect(existsSync(join(root, 'person', '.codex', 'hooks.json'))).toBe(false)
  })

  it('without trust, passes no hooks and reports the session untrusted', async () => {
    const result = await codexInstrumentation.install(destination(async () => undefined))
    expect(result.args).toEqual([])
    expect(result.degradedKind).toBe('untrusted')
  })

  it('flags every Podium hook event, in the inline form Codex reads', () => {
    const flags = codexHookLaunchFlags()
    const events = flags.filter((_, index) => index % 2 === 1).map((flag) => flag.split('=')[0])
    expect(events).toEqual([
      'hooks.SessionStart',
      'hooks.UserPromptSubmit',
      'hooks.PreToolUse',
      'hooks.PermissionRequest',
      'hooks.PostToolUse',
      'hooks.Stop',
    ])
    expect(flags.filter((flag) => flag === '-c')).toHaveLength(6)
  })
})
