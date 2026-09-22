/**
 * THE CODEX EXEC TURN'S ARGV (moved behaviors from
 * apps/daemon/src/headless-drivers.test.ts in 1.5 with the code they pin).
 *
 * Argv off the adapter's `headless.buildExec` section. The JSONL fold over a
 * stand-in `codex exec --json` moved with the fold to the headless family
 * (../headless/turn.test.ts, POD-4614).
 */

import { describe, expect, it } from 'vitest'
import type { ResolvedHarnessInventory } from '../../../inventory/build-inventory.js'
import { buildCodexExecTurn } from './exec-turn.js'
import { manifestFor } from '../../../registry.js'

/** The real headless section, handed in (tests may read the registry). */
function headlessSections() {
  return { headless: manifestFor('codex')!.headless }
}

function snapshot(): ResolvedHarnessInventory {
  return {
    executables: new Map([
      ['codex', { kind: 'codex', path: '/opt/codex', generation: 1 }],
    ]),
    commandEnvironment: {
      env: { PATH: '/opt:/usr/bin:/bin', HOME: '/tmp' },
      pathEntries: ['/opt', '/usr/bin', '/bin'],
      source: 'inherited',
      generation: 1,
      machineHome: '/tmp',
      loginShell: '/bin/sh',
      resolve: () => undefined,
    },
  } as unknown as ResolvedHarnessInventory
}

describe('buildCodexExecTurn argv shapes', () => {
  it('first turn: exec --json with positional prompt, no resume subcommand', () => {
    const { cmd, args } = buildCodexExecTurn({ prompt: 'hi there' }, snapshot(), headlessSections())
    expect(cmd).toBe('/opt/codex')
    expect(args).toEqual(['exec', '--json', '--skip-git-repo-check', 'hi there'])
  })

  it('resume turn: exec resume <id> subcommand before flags', () => {
    const { args } = buildCodexExecTurn(
      { prompt: 'go on', resumeValue: '019f-abc', model: 'gpt-5.2-codex' },
      snapshot(),
      headlessSections(),
    )
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '019f-abc'])
  })
})
