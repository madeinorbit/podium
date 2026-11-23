/**
 * The side-state guard under tests (POD-7454): a client derivation that reads
 * a `SideMap`/`SideSet` outside a reviewed `signalledRead` boundary throws,
 * and the test fails even when a defensive catch or MobX's reaction error
 * handler swallowed that throw: the guard records every violation, and this
 * file fails the test from the record.
 *
 * Server and daemon files run no client derivations, so they skip it.
 *
 * `PODIUM_SIDE_STATE_GUARD=record` records without throwing, so one run lists
 * every site: a throw stops its derivation and hides the reads after it.
 */

import { afterEach, beforeEach, expect } from 'vitest'

const testPath = (expect.getState().testPath ?? '').replaceAll('\\', '/')

if (!testPath.includes('/apps/server/') && !testPath.includes('/apps/daemon/')) {
  const { installSideStateGuard, takeSideStateViolations } = await import(
    './packages/client-graph/src/side-state-guard'
  )
  installSideStateGuard(process.env.PODIUM_SIDE_STATE_GUARD === 'record' ? 'warn' : 'throw')
  beforeEach(() => {
    takeSideStateViolations()
  })
  afterEach(() => {
    const violations = takeSideStateViolations()
    if (violations.length === 0) return
    throw new Error(
      `side state read inside a MobX derivation (POD-7454):\n${violations
        .map((violation) => `  ${violation.collection} at ${violation.site}`)
        .join('\n')}`,
    )
  })
}
