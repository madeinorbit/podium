import { missionRootFor } from '@podium/client-core/viewmodels'
import { asIssueId } from '@podium/model/browser'
import { expect, it } from 'vitest'
import { measurePoolMission, missionLegacyCountsFor, resetMissionLegacyCounts } from './mission-pane-perf'

it('attributes a legacy derivation inside a pool read to its existing store owner', () => {
  const owner = {}, other = {}
  expect(measurePoolMission(owner, () => 42)).toBe(42)
  expect(missionLegacyCountsFor(owner)).toEqual({})
  const id = asIssueId('census-control')
  const derived = measurePoolMission(owner, () => missionRootFor([{ id, stage: 'backlog', archived: false }], id))
  expect(derived?.id).toBe(id)
  expect(missionLegacyCountsFor(owner)['pool.mission.builds']).toBe(1)
  expect(missionLegacyCountsFor(other)).toEqual({})
  resetMissionLegacyCounts(owner)
  expect(missionLegacyCountsFor(owner)).toEqual({})
})
