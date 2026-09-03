import { scoreA2aPushes, type StatePush } from './a2a-push-observer'

const acceptedMono = 1_000
const acceptedWall = Date.parse('2026-08-30T02:00:00.000Z')
const push = (delta: number, phase: string, sourceDelta = delta): StatePush => ({
  receiveMonoMs: acceptedMono + delta,
  receiveWallMs: acceptedWall + delta,
  phase,
  since: new Date(acceptedWall + sourceDelta).toISOString(),
  stateObservedAt: new Date(acceptedWall + sourceDelta).toISOString(),
  state: { phase },
})
const check = (name: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) throw new Error(name + ': expected ' + expected + ', got ' + actual)
  console.log('PASS ' + name)
}

check('prompt receive upper bound PASS', scoreA2aPushes([push(500, 'working'), push(900, 'idle')], acceptedMono, acceptedWall, acceptedMono + 800).verdict, 'PASS')
check('authoritative late timestamp proven FAIL', scoreA2aPushes([push(2200, 'working', 2100), push(2600, 'idle')], acceptedMono, acceptedWall, acceptedMono + 2500).verdict, 'FAIL')
check('ambiguous late delivery PARTIAL', scoreA2aPushes([push(2200, 'working', 1500), push(2600, 'idle')], acceptedMono, acceptedWall, acceptedMono + 2500).verdict, 'PARTIAL')
check('mid-working flicker FAIL', scoreA2aPushes([push(300, 'working'), push(500, 'idle'), push(700, 'working'), push(900, 'idle')], acceptedMono, acceptedWall, acceptedMono + 800).verdict, 'FAIL')
check('missing pushed final idle FAIL', scoreA2aPushes([push(300, 'working')], acceptedMono, acceptedWall, acceptedMono + 800).verdict, 'FAIL')
