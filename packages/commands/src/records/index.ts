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
  RECORD_OPS,
  type RecordConflict,
  type RecordField,
  type RecordFieldRole,
  type RecordOp,
  recordCommandName,
  type SyncedKindDeclaration,
  specFields,
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
export { ISSUE_RECORD, SESSION_RECORD, SESSION_USER_STATE_RECORD, SYNCED_KINDS } from './kinds'
