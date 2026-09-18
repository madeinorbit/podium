import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { UpdateGrantMessage, UpdateStatusMessage } from '@podium/protocol'
import { MachineUpdateExecutor } from './machine-update'
import { UpdateGateError } from './update-failure'

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const grant: UpdateGrantMessage = { type: 'updateGrant', grantId: 'one', issuedAt: 1, target: { version: '2', critical: false, artifacts: {} } }
function setup() {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'update-report-'))
  roots.push(runtimeDir)
  const statuses: UpdateStatusMessage[] = []
  const deps = {
    runtimeDir, now: () => 123,
    adapter: {
      runningVersion: () => '1', prepare: async () => ({ digest: 'new' }), activate: async () => {}, discard: async () => {},
      restart: async () => { throw new UpdateGateError({ reasonCode: 'daemon-silent', detail: 'Successor failed its health gate: daemon did not report healthy.' }) },
    }, report: (status: UpdateStatusMessage) => { statuses.push(status) },
  }
  return { runner: new MachineUpdateExecutor(deps), deps, statuses }
}
it('replays a durable gate cause with predecessor version and original timestamp after restart', async () => {
  const { runner, deps, statuses } = setup()
  await runner.accept(grant)
  const terminal = statuses.at(-1)
  expect(terminal).toMatchObject({ state: 'stuck', version: '1', targetVersion: '2', reasonCode: 'daemon-silent', reportedAt: 123 })
  statuses.length = 0
  new MachineUpdateExecutor({ ...deps, now: () => 456 }).replay()
  expect(statuses).toEqual([terminal])
})
it('preserves rollback cause instead of overwriting it with the later handover exception', async () => {
  const { runner, deps, statuses } = setup()
  deps.adapter.restart = async () => {
    runner.reportFailure({ reasonCode: 'rolled-back', detail: 'Update rolled back to 0.' }, '0')
    throw new Error('handover aborted')
  }
  await runner.accept(grant)
  expect(statuses.at(-1)).toMatchObject({ state: 'stuck', version: '0', reasonCode: 'rolled-back', detail: 'Update rolled back to 0.' })
})
it('queues grant refusals for reconnect', () => {
  const { runner, statuses } = setup()
  runner.reportGrantRefusal(grant, new Error('unauthorized-target'))
  const expected = statuses.at(-1)
  statuses.length = 0
  runner.replay()
  expect(statuses).toEqual([expected])
  expect(expected).toMatchObject({ state: 'rejected', reasonCode: 'grant-refused', reportedAt: 123 })
})
it('reports an idle daemon refusal as current, deduplicates it, and clears replay on recovery', () => {
  const { runner, statuses } = setup()
  runner.reportDaemonRefusal('protocol-mismatch: peer wire version too new')
  runner.reportDaemonRefusal('protocol-mismatch: peer wire version too new')
  expect(statuses).toHaveLength(1)
  expect(statuses[0]).toMatchObject({ state: 'current', reasonCode: 'daemon-refused', detail: 'Daemon refused: protocol-mismatch: peer wire version too new.', reportedAt: 123 })
  runner.replay()
  expect(statuses).toHaveLength(2)
  runner.reportDaemonRefusal()
  runner.replay()
  expect(statuses).toHaveLength(2)
})
it('does not publish an unsolicited current report while a grant is in flight', async () => {
  const { runner, statuses } = setup()
  await runner.accept(grant, true, true)
  statuses.length = 0
  runner.reportDaemonRefusal('refused')
  expect(statuses).toEqual([])
})

it('a new terminal cause supersedes an older unsolicited observation during replay', async () => {
  const { runner, statuses } = setup()
  await runner.accept(grant)
  runner.reportDaemonRefusal('refused')
  runner.reportFailure({ reasonCode: 'rollback-refused-no-bundle', detail: 'rollback unavailable: no .old bundle retained to restore' })
  statuses.length = 0
  runner.replay()
  expect(statuses).toHaveLength(1)
  expect(statuses[0]).toMatchObject({ state: 'stuck', reasonCode: 'rollback-refused-no-bundle' })
})
