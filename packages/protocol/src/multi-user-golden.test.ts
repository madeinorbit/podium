import { describe, expect, it } from 'vitest'
import { buildCorpus, type WireCase, type WireFamily } from './__fixtures__/build'
import { GOLDEN } from './__fixtures__/golden/index'
import { coveredSchemas } from './__fixtures__/registry'

const participation = ['joinedAt', 'joinedVia', 'assignedAt', 'assignedBy']
const sharedResult = [
  'machines.0.custodian',
  'issueProjections.0.legacyAssignee',
  ...participation.map((field) => `issueUserStates.0.${field}`),
]
const resultVariants = Array.from({ length: 7 }, (_, i) => `full/arm${i + 1}`)
const fields: Array<{ family: string; schema: string; paths: string[]; variants?: string[] }> = [
  {
    family: 'model',
    schema: 'AccountView',
    paths: ['sentTo', 'sendableTo', 'useOnMyMachines', 'keptOn'],
  },
  { family: 'model', schema: 'IssueAggregate', paths: ['legacyAssignee'] },
  {
    family: 'model',
    schema: 'IssueComment',
    paths: ['authorId', 'editedAt', 'editedBy', 'mayEdit'],
  },
  { family: 'model', schema: 'IssueProjection', paths: ['legacyAssignee'] },
  { family: 'model', schema: 'IssueTriage', paths: ['legacyAssignee'] },
  { family: 'model', schema: 'IssueUserState', paths: participation },
  { family: 'model', schema: 'IssueUserStateWire', paths: participation },
  { family: 'model', schema: 'MachineProjection', paths: ['custodian'] },
  { family: 'sync', schema: 'IssueProjection', paths: ['legacyAssignee'] },
  { family: 'sync', schema: 'IssueUserStateWire', paths: participation },
  { family: 'sync', schema: 'MachineProjection', paths: ['custodian'] },
  {
    family: 'feed',
    schema: 'FeedChange',
    paths: ['value.legacyAssignee'],
    variants: ['full/arm1'],
  },
  {
    family: 'feed',
    schema: 'FeedBootstrapMessage',
    paths: ['changes.0.value.legacyAssignee'],
    variants: ['full/arm1'],
  },
  {
    family: 'feed',
    schema: 'FeedDeltaMessage',
    paths: ['changes.0.value.legacyAssignee'],
    variants: ['full/arm1'],
  },
  {
    family: 'sync',
    schema: 'MetadataChange',
    paths: ['value.legacyAssignee'],
    variants: ['full/arm1'],
  },
  {
    family: 'sync',
    schema: 'MetadataDeltaMessage',
    paths: ['changes.0.value.legacyAssignee'],
    variants: ['full/arm1'],
  },
  {
    family: 'sync',
    schema: 'SyncChangesSinceResult',
    paths: sharedResult,
    variants: resultVariants,
  },
  {
    family: 'sync',
    schema: 'SyncChangesSinceResultLenientSchema',
    paths: sharedResult,
    variants: resultVariants,
  },
]

const corpus = buildCorpus()

function at(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

function goldenCase(family: string, schema: string, variant: string): WireCase {
  const cases = (GOLDEN[family] as WireFamily).cases
  const result = cases.find((row) => row.schema === schema && row.variant === variant)
  if (!result) throw new Error(`missing golden ${family}/${schema}/${variant}`)
  return result
}

// Keep these contract additions visible even while unrelated baseline golden
// drift prevents the broad characterization file from completing its report.
describe.each(fields)('multi-user golden $family/$schema', ({
  family,
  schema,
  paths,
  variants,
}) => {
  it('pins each optional addition in both wire and encoded bytes', () => {
    const samples = corpus
      .find((row) => row.family === family)
      ?.cases.filter(
        (row) =>
          row.schema === schema &&
          (variants?.includes(row.variant) ?? row.variant.startsWith('full')),
      )
    expect(samples?.length).toBeGreaterThan(0)
    for (const sample of samples ?? []) {
      const golden = goldenCase(family, schema, sample.variant)
      for (const [actual, recorded] of [
        [sample.wire, golden.wire],
        [JSON.parse(sample.encoded), JSON.parse(golden.encoded)],
      ]) {
        const project = (value: unknown) =>
          Object.fromEntries(paths.map((path) => [path, at(value, path)]))
        for (const path of paths)
          expect(at(actual, path), `${schema}/${sample.variant}/${path}`).not.toBeUndefined()
        expect(project(recorded)).toEqual(project(actual))
      }
    }
  })
})

describe.each(fields.filter((row) => row.family === 'model'))('legacy minimum $schema', ({
  schema,
}) => {
  it('still parses without the optional multi-user fields', () => {
    const entry = coveredSchemas().find((row) => row.family === 'model' && row.name === schema)
    if (!entry) throw new Error(`missing schema ${schema}`)
    expect(entry.schema.safeParse(goldenCase('model', schema, 'minimal').wire).success).toBe(true)
  })
})

it('records the new IssueJoinVia schema without changing its wire value', () => {
  const actual = corpus
    .find((row) => row.family === 'model')
    ?.cases.filter((row) => row.schema === 'IssueJoinVia')
  expect(actual?.map((row) => row.variant)).toEqual(['minimal', 'full'])
  for (const row of actual ?? []) expect(goldenCase('model', row.schema, row.variant)).toEqual(row)
})
