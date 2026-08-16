import { describe, expect, it } from 'vitest'
import { approvalArgv } from './approvals'

describe('approvalArgv (closed op → fixed argv, #410)', () => {
  it('maps every catalog op', () => {
    expect(approvalArgv({ kind: 'update' })).toEqual(['update'])
    expect(approvalArgv({ kind: 'channel', target: 'edge' })).toEqual(['channel', 'edge'])
    // POD-2199 — the far end of the brokered path: what the daemon actually runs
    // once the operator approves an agent's request to pin the machine to `dev`.
    expect(approvalArgv({ kind: 'channel', target: 'dev' })).toEqual(['channel', 'dev'])
    expect(approvalArgv({ kind: 'stop' })).toEqual(['stop'])
    expect(approvalArgv({ kind: 'set-server', target: 'wss://x' })).toEqual([
      'set-server',
      'wss://x',
    ])
  })
})
