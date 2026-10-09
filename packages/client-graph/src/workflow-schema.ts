import { SETUP_SESSION_SUMMARY_FIELDS } from './settings-schema'

/** Workflow wires stay owned by their RPC hook. Placement borrows the existing
 * resident machine catalog; subjects use the declared issue identity and the
 * existing deduplicated session summary. No replicated workflow rows, new
 * source, or maintained relationship index is needed for these keyed reads. */
export const WORKFLOW_SCHEMA = {
  machines: { catalog: 'settingsCatalog', entity: 'machine', source: 'pool:machine' },
  issue: { entity: 'issue', fields: ['id'], residency: 'declared-summary' },
  session: { entity: 'session', fields: SETUP_SESSION_SUMMARY_FIELDS, residency: 'declared-summary' },
  relations: {},
} as const

export const WORKFLOW_SUMMARIES = {
  issue: WORKFLOW_SCHEMA.issue.fields,
  session: WORKFLOW_SCHEMA.session.fields,
}
