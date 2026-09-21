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
  CursorParts,
  SYNTHESIZED_ITEM_ID_PREFIX,
  decodeCursor,
  encodeCursor,
  recordUuid,
  stampCursors,
} from './store/cursor-codec.js'
export {
  ChainEntry,
  fileIdFor,
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
  OpencodeMessagePartRow,
  classifyOpencodeIdleText,
  isOpencodeMessageAborted,
  opencodePartToItems,
  opencodeRowsToItems,
} from './store/opencode.js'
export {
  piRecordToItems,
  piRuntime,
} from './store/pi.js'
export {
  HarnessRuntimeObservation,
  TranscriptRuntimeReader,
  claudeRuntime,
  codexRuntime,
  grokRuntime,
} from './store/runtime.js'
export {
  SliceOptions,
  SliceResult,
  resetSliceCache,
  sliceCacheStats,
} from './store/slice.js'
export {
  TranscriptRecordMapper,
  TranscriptSource,
  fileChainSource,
  opencodeFileId,
  sliceItemsByAnchor,
  stampOpencodeItems,
} from './store/source.js'
export {
  SharedStatTick,
  StatTick,
  createSharedStatTick,
  scheduleStatPoll,
} from './store/stat-tick.js'
export {
  streamIdOfCursor,
  streamItemIdOf,
} from './store/stream-identity.js'
export {
  TranscriptTailMeta,
  TranscriptTailOptions,
  TranscriptTailStatus,
  TranscriptTailer,
  tailTranscript,
} from './store/tailer.js'
export {
  TOOL_EDIT_KIND,
  ToolEditHunk,
  ToolEditMode,
  ToolEditPayload,
  extractToolEdit,
  extractToolEditFromPatch,
  isFileEditToolName,
  looksLikePatch,
  safeToolEditJson,
  safeToolEditJsonFromInput,
} from './store/tool-edit.js'
