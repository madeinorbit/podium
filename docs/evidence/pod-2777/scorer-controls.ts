import assert from 'node:assert/strict'
import { isA1cTypedRefusal, scoreA1c, scoreA9 } from './scorer-contracts'

const typedDeadLetter = isA1cTypedRefusal({
  ok: false,
  hasError: false,
  reason: 'dead-lettered: session no longer exists',
  disposition: 'dead_letter',
  errorMessage: '',
})
assert.equal(typedDeadLetter, true)

const explicitRefusal = scoreA1c({
  controlFired: true,
  deadConfirmed: true,
  typedRefusal: typedDeadLetter,
  accepted: false,
  delayedDelivered: false,
})
assert.equal(explicitRefusal, 'PASS')

const acceptedThenLost = scoreA1c({
  controlFired: true,
  deadConfirmed: true,
  typedRefusal: true,
  accepted: true,
  delayedDelivered: false,
})
assert.equal(acceptedThenLost, 'FAIL')

const acceptedThenDelivered = scoreA1c({
  controlFired: true,
  deadConfirmed: true,
  typedRefusal: false,
  accepted: true,
  delayedDelivered: true,
})
assert.equal(acceptedThenDelivered, 'PASS')

const resumeOnlyTypedRefusal = isA1cTypedRefusal({
  ok: false,
  hasError: false,
  reason: 'resume and send offered',
  disposition: 'resume',
  errorMessage: '',
})
assert.equal(resumeOnlyTypedRefusal, false)
const resumeOnly = scoreA1c({
  controlFired: true,
  deadConfirmed: true,
  typedRefusal: resumeOnlyTypedRefusal,
  accepted: false,
  delayedDelivered: false,
})
assert.equal(resumeOnly, 'FAIL')

const clean = {
  controlFired: true,
  stampProven: true,
  originalProcesses: [{ pid: 101, startTimeTicks: '1001' }],
  originalProcessesAliveAt15s: [],
  originalProcessesAliveAt300s: [],
  stampedProcessesAt15s: [],
  stampedProcessesAt300s: [],
  infrastructureAlive: 2,
} as const
assert.equal(scoreA9(clean).verdict, 'PASS')
assert.equal(scoreA9({ ...clean, stampProven: false }).verdict, 'REFUSED')

const reboundAt15s = scoreA9({
  ...clean,
  stampedProcessesAt15s: [{ pid: 202, startTimeTicks: '2002' }],
})
assert.equal(reboundAt15s.verdict, 'FAIL')
assert.deepEqual(reboundAt15s.reboundsAt15s, [202])
assert.deepEqual(reboundAt15s.reboundsAt300s, [])

const reboundAt300s = scoreA9({
  ...clean,
  stampedProcessesAt300s: [{ pid: 303, startTimeTicks: '3003' }],
})
assert.equal(reboundAt300s.verdict, 'FAIL')
assert.deepEqual(reboundAt300s.reboundsAt15s, [])
assert.deepEqual(reboundAt300s.reboundsAt300s, [303])

const aliveButUnstampedAt15s = scoreA9({
  ...clean,
  originalProcessesAliveAt15s: clean.originalProcesses,
})
assert.equal(aliveButUnstampedAt15s.verdict, 'FAIL')
assert.deepEqual(aliveButUnstampedAt15s.survivorsAt15s, [101])

const aliveButUnstampedAt300s = scoreA9({
  ...clean,
  originalProcessesAliveAt300s: clean.originalProcesses,
})
assert.equal(aliveButUnstampedAt300s.verdict, 'FAIL')
assert.deepEqual(aliveButUnstampedAt300s.survivorsAt300s, [101])

const reusedPidRebound = scoreA9({
  ...clean,
  stampedProcessesAt300s: [{ pid: 101, startTimeTicks: 'later-process' }],
})
assert.equal(reusedPidRebound.verdict, 'FAIL')
assert.deepEqual(reusedPidRebound.reboundsAt300s, [101])

console.log('SCORER CONTROLS PASS')
console.log(`A1c accepted-then-lost -> ${acceptedThenLost}`)
console.log(`A1c resume-only -> ${resumeOnly}`)
console.log(`A9 rebound at 15s -> ${reboundAt15s.verdict}`)
console.log(`A9 rebound at 300s -> ${reboundAt300s.verdict}`)
console.log(`A9 original alive but unstamped at 15s -> ${aliveButUnstampedAt15s.verdict}`)
console.log(`A9 original alive but unstamped at 300s -> ${aliveButUnstampedAt300s.verdict}`)
