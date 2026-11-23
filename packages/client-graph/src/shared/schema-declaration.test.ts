/**
 * THE POOL SCHEMA READS THE RECORD DECLARATIONS (POD-7084).
 *
 * Every field the pool schema cites from a record's own wire schema, on that
 * record's client collection, is a field the record declaration declares (in
 * any part: a body field travels as its own record, a live one through the
 * LiveStore). Every collection a field or component arrives on is a declared
 * record type's. Relation keys between records come from declared links
 * (`link()` in `schema.ts`), so they are checked when the schema loads.
 */

import { type RecordDeclaration, recordOfReplicaKind } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { type FieldSource, SCHEMA } from './schema'

/** The wire schema names a record type is cited by. */
const OWN_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  issueProjection: ['IssueProjection', 'SlimIssueProjection'],
  session: ['SessionMeta'],
  sessionUserState: ['SessionUserStateWire'],
  issueUserState: ['IssueUserStateWire'],
  issueGitState: ['IssueGitStateProjection'],
  issueDep: ['IssueDepProjection'],
  repo: ['RepoProjection'],
  machine: ['MachineProjection'],
  machineAccess: ['MachineAccessWire'],
  checkout: ['CheckoutWire'],
  effect: ['EffectRecordWire'],
  automation: ['AutomationWire'],
  automationRun: ['AutomationRunWire'],
  message: ['MessageRecordWire'],
  pendingInteraction: ['PendingInteractionWire'],
  issueBrief: ['IssueBriefWire'],
  issueDescription: ['IssueDescriptionWire'],
  issuePanelTodo: ['IssuePanelTodoWire'],
  issuePanelArtifact: ['IssuePanelArtifactWire'],
  issuePanelDeferred: ['IssuePanelDeferredWire'],
  issuePanelState: ['IssuePanelStateWire'],
  workflowRun: ['WorkflowRunRecord'],
}

interface Citation {
  readonly at: string
  readonly property: string
  readonly source: FieldSource
}

function citations(): Citation[] {
  const out: Citation[] = []
  for (const [entity, spec] of Object.entries(SCHEMA)) {
    for (const [name, field] of Object.entries(spec.fields)) {
      out.push({
        at: `${entity}.${name}`,
        property: field.source.property ?? name,
        source: field.source,
      })
    }
  }
  return out
}

const declarationOf = (arrivesOn: string): RecordDeclaration | undefined =>
  arrivesOn.startsWith('replica:')
    ? recordOfReplicaKind(arrivesOn.slice('replica:'.length))
    : undefined

/** Every citation of a record's own schema whose property the declaration does not declare. */
function undeclared(list: readonly Citation[]): string[] {
  return list.flatMap(({ at, property, source }) => {
    const declaration = declarationOf(source.arrivesOn)
    if (declaration === undefined || !OWN_SCHEMA[declaration.kind]?.includes(source.schema))
      return []
    return declaration.partOf(property) === undefined
      ? [`${at} cites ${declaration.kind}.${property}`]
      : []
  })
}

describe('the pool schema and the record declarations', () => {
  it('cites only declared fields of a record', () => {
    expect(undeclared(citations())).toEqual([])
  })

  it('names only declared record collections', () => {
    for (const { at, source } of citations()) {
      if (source.arrivesOn.startsWith('replica:'))
        expect(declarationOf(source.arrivesOn), at).toBeDefined()
    }
    for (const [entity, spec] of Object.entries(SCHEMA)) {
      for (const component of Object.values(spec.components)) {
        if (component.arrivesOn.startsWith('replica:')) {
          expect(declarationOf(component.arrivesOn), `${entity} component`).toBeDefined()
        }
      }
    }
  })

  it('checks real citations: one the declaration lacks is caught', () => {
    const cited = citations()
    expect(
      cited.filter((c) => declarationOf(c.source.arrivesOn)?.kind === 'session').length,
    ).toBeGreaterThan(20)
    const wrong: Citation = {
      at: 'session.made-up',
      property: 'madeUp',
      source: { schema: 'SessionMeta', arrivesOn: 'replica:sessions' },
    }
    expect(undeclared([...cited, wrong])).toEqual(['session.made-up cites session.madeUp'])
  })
})
