// @vitest-environment happy-dom
/**
 * N1b (`POD-4593`) — throwaway runner: L6b's five probes against the MobX
 * pool arm, recording every verdict. No assertions (a firing is the record,
 * not a failure); the tables land in
 * `docs/decisions/pod-4545-round-three-n-mobx-probes.md`.
 *
 * Run one probe: `N1B_PROBE=P1 bun ../../scripts/validation-admission.ts
 * focused --label n1b -- bun --bun ../../node_modules/vitest/vitest.mjs run
 * --config vitest.config.ts shared/src/probes/n1b-mobx.test.tsx`
 * from `packages/worklist-proto`. DELETE before landing (arm byte-identical).
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mobxPoolArm } from '../../../arms/mobx/pool/arm'
import { writeResult } from '../../../harness/src/results'
import { PROBES, runProbe, verdicts, type ProbeSubject } from './index'

const TIMEOUT = 10 * 60_000

const MOBX: ProbeSubject = {
  name: 'mobx pool',
  mode: 'overlaid',
  armFor: () => mobxPoolArm,
  lintFolder: 'mobx',
}

const only = process.env['N1B_PROBE']?.trim() ?? ''
const results: Record<string, unknown> = {}

for (const probe of PROBES) {
  if (only !== '' && !probe.id.includes(only)) continue
  describe(probe.id, () => {
    it(
      'record every verdict (no assertions)',
      async () => {
        const run = await runProbe(probe, MOBX)
        const got = verdicts(probe, run)
        results[probe.id] = got.map((v) => ({
          instrument: v.instrument,
          kind: v.kind,
          verdict: v.verdict,
          ...(v.blind === undefined ? {} : { blind: v.blind }),
          evidence: v.evidence.slice(0, 400),
        }))
        for (const v of got) {
          console.log(
            `[N1b ${probe.id}] ${v.instrument}: ${v.verdict}${v.blind === undefined ? '' : ` (blind: ${v.blind})`} — ${v.evidence.slice(0, 400)}`,
          )
        }
        expect(Object.keys(results)).toContain(probe.id)
      },
      TIMEOUT,
    )
  })
}

afterAll(() => {
  if (Object.keys(results).length > 0) writeResult(`n1b-mobx-${only === '' ? 'all' : only}`, results)
})
