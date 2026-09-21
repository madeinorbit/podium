/**
 * `@podium/harness/store` — THE TRANSCRIPT STORE ENTRY (POD-4469).
 *
 * The transcript reader surface both sides share: per-harness JSONL
 * record-to-item mappers, the bounded slice reader, cursor codec, stream
 * identity, file-chain ids and the live tailer. Dissolved from
 * `@podium/transcript` with no behaviour change — the module for module list
 * below names every export that barrel carried.
 *
 * This entry is OPEN (the server builds its memory lake over it, the daemon
 * its transcript plane), so there is no `export *` here and there may never
 * be one: `manifest-open-entrypoint` holds the surface enumerable, exactly as
 * for `@podium/harness/driver`. The sqlite-backed source stays host-only
 * behind `@podium/harness` (the daemon barrel), never here.
 */
export {
  askQuestionPreview,
  claudeRecordColor,
  claudeRecordEffort,
  claudeRecordModel,
  claudeRecordToItems,
  claudeToolCallItem,
  claudeToolResultItem,
  isClaudeInterruptMarker,
  safeAskQuestionInputJson,
  toolInputPreview,
} from './store/claude.js'
export {
  codexRecordToItems,
} from './store/codex.js'
export {
  cursorRecordToItems,
} from './store/cursor.js'
export {
  SYNTHESIZED_ITEM_ID_PREFIX,
  decodeCursor,
  encodeCursor,
  recordUuid,
  stampCursors,
} from './store/cursor-codec.js'
export type {
  CursorParts,
} from './store/cursor-codec.js'
export {
  fileIdFor,
} from './store/file-chain.js'
export type {
  ChainEntry,
} from './store/file-chain.js'
export {
  grokRecordToItems,
} from './store/grok.js'
export {
  contentToText,
  isRecord,
  stringField,
} from './store/json-util.js'
export {
  classifyOpencodeIdleText,
  isOpencodeMessageAborted,
  opencodePartToItems,
  opencodeRowsToItems,
} from './store/opencode.js'
export type {
  OpencodeMessagePartRow,
} from './store/opencode.js'
export {
  piRecordToItems,
  piRuntime,
} from './store/pi.js'
export {
  claudeRuntime,
  codexRuntime,
  grokRuntime,
} from './store/runtime.js'
export type {
  HarnessRuntimeObservation,
  TranscriptRuntimeReader,
} from './store/runtime.js'
export {
  readFileItems,
  readTranscriptSlice,
  readTranscriptSliceCached,
  resetSliceCache,
  sliceCacheStats,
} from './store/slice.js'
export type {
  SliceOptions,
  SliceResult,
} from './store/slice.js'
export {
  fileChainSource,
  opencodeFileId,
  sliceItemsByAnchor,
  stampOpencodeItems,
} from './store/source.js'
export type {
  TranscriptRecordMapper,
  TranscriptSource,
} from './store/source.js'
export {
  createSharedStatTick,
  scheduleStatPoll,
} from './store/stat-tick.js'
export type {
  SharedStatTick,
  StatTick,
} from './store/stat-tick.js'
export {
  streamIdOfCursor,
  streamItemIdOf,
} from './store/stream-identity.js'
export {
  tailTranscript,
} from './store/tailer.js'
export type {
  TranscriptTailMeta,
  TranscriptTailOptions,
  TranscriptTailStatus,
  TranscriptTailer,
} from './store/tailer.js'
export {
  TOOL_EDIT_KIND,
  extractToolEdit,
  extractToolEditFromPatch,
  isFileEditToolName,
  looksLikePatch,
  safeToolEditJson,
  safeToolEditJsonFromInput,
} from './store/tool-edit.js'
export type {
  ToolEditHunk,
  ToolEditMode,
  ToolEditPayload,
} from './store/tool-edit.js'
