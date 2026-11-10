import { describe, expect, it } from 'vitest'
import { UserPreferencesWire } from '../user-state/synced-records'
import { InstancePreferencesWire } from './instance-record'

describe('retired settings record fields', () => {
  for (const [name, schema, current] of [
    ['personal', UserPreferencesWire, { userId: 'operator', 'sidebar.repoSort': 'alphabetical' }],
    ['instance', InstancePreferencesWire, { 'gitWorkflow.defaultParentBranch': 'release' }],
  ] as const) {
    it(`${name} reads pre-redesign records without retaining retired leaves`, () => {
      expect(
        schema.parse({
          ...current,
          'sidebar.groupByRepo': true,
          'gitWorkflow.mergeStyle': 'pr',
        }),
      ).toEqual(current)
    })
    it(`${name} still rejects an unrelated unknown field`, () => {
      expect(schema.safeParse({ ...current, unrelated: true }).success).toBe(false)
    })
  }
})
