import { DEFAULT_SHIPWRIGHT_BUDGET, ShipwrightPatchContract, shipRepairRef } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { validateShipwrightPatch } from './shipwright'

describe('bounded shipwright patch contract', () => {
  it('accepts an exact text patch and marks test changes for Inspector review', () => {
    const contract = ShipwrightPatchContract.parse({
      kind: 'patch',
      summary: 'keep the assertion aligned with the implementation',
      behaviorImpact: 'none',
      touchedPaths: ['src/value.test.ts'],
      patch:
        'diff --git a/src/value.test.ts b/src/value.test.ts\n' +
        '--- a/src/value.test.ts\n+++ b/src/value.test.ts\n@@ -1 +1 @@\n-expect(1)\n+expect(2)\n',
    })
    expect(validateShipwrightPatch(contract)).toEqual({
      ok: true,
      paths: ['src/value.test.ts'],
      risky: true,
    })
  })

  it('rejects undeclared, binary, policy, traversal, and oversized changes', () => {
    const base = {
      kind: 'patch' as const,
      summary: 'repair',
      behaviorImpact: 'none' as const,
      concerns: [],
    }
    expect(
      validateShipwrightPatch({
        ...base,
        touchedPaths: ['src/b.ts'],
        patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n',
      }).ok,
    ).toBe(false)
    expect(
      validateShipwrightPatch({
        ...base,
        touchedPaths: ['asset.png'],
        patch: 'diff --git a/asset.png b/asset.png\nGIT binary patch\n',
      }).ok,
    ).toBe(false)
    expect(
      validateShipwrightPatch({
        ...base,
        touchedPaths: ['AGENTS.md'],
        patch: 'diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n',
      }).ok,
    ).toBe(false)
    expect(
      validateShipwrightPatch({
        ...base,
        touchedPaths: ['../secret'],
        patch: 'diff --git a/../secret b/../secret\n--- a/../secret\n+++ b/../secret\n',
      }).ok,
    ).toBe(false)
    expect(
      validateShipwrightPatch(
        {
          ...base,
          touchedPaths: ['src/a.ts'],
          patch: `diff --git a/src/a.ts b/src/a.ts\n${'x'.repeat(2_000)}`,
        },
        { ...DEFAULT_SHIPWRIGHT_BUDGET, maxPatchBytes: 1_024 },
      ).ok,
    ).toBe(false)
  })

  it('mints only attempt and generation scoped refs', () => {
    expect(shipRepairRef('attempt:one/two', 7)).toBe(
      'refs/podium/ship-repair/attempt-one-two/7',
    )
  })
})
