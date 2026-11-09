/**
 * THE GENERIC RECORD DECLARATIONS, FOR CLIENTS (`@podium/commands/records`).
 *
 * A browser-light entry: the declarations, the synced kinds and the three
 * commands' input schemas, without the rest of the command registry. A client
 * reads these to type and check its one edit API and to paint a patch
 * (ADR 12 D3); it never reads a conflict function from here.
 */

export { recordCreateInput, recordEditInput, recordRemoveInput } from './contracts'
export {
  createFields,
  editNeedsRevision,
  fieldConflict,
  RECORD_OPS,
  type RecordConflict,
  type RecordField,
  type RecordFieldRole,
  type RecordOp,
  recordCommandName,
  type SyncedKindDeclaration,
  specFields,
  unsettableFields,
} from './declare'
export {
  type FreshContext,
  type FreshRecord,
  freshCreateFields,
  freshRow,
  pendingCells,
  wireCells,
} from './fresh'
export {
  ISSUE_FIELD_DEFAULTS,
  ISSUE_FRESH_CELLS,
  issueSeqPending,
  PENDING_ISSUE_SEQ,
} from './issue-fresh'
export {
  AGENT_PROFILE_RECORD,
  EFFECT_RECORD,
  INSTANCE_PREFERENCES_RECORD,
  ISSUE_RECORD,
  ISSUE_USER_STATE_RECORD,
  PIN_RECORD,
  SESSION_RECORD,
  SESSION_USER_STATE_RECORD,
  SUPERAGENT_THREAD_RECORD,
  SUBSCRIPTION_RECORD,
  SYNCED_KINDS,
  TAB_ORDER_RECORD,
  USER_LAYOUT_RECORD,
  USER_PREFERENCES_RECORD,
  USER_READ_POSITION_RECORD,
  WORKFLOW_BINDING_RECORD,
} from './kinds'
