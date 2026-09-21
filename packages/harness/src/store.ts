/**
 * `@podium/harness/store` — THE TRANSCRIPT STORE ENTRY (POD-4469, POD-4471).
 *
 * The transcript reader surface both sides share: the bounded slice reader,
 * cursor codec, stream identity, file-chain ids, in-memory slicing and the
 * live tailer, plus the grammar-parameterized Store constructor. Per-harness
 * record grammars live in `adapters/<h>/transcript.ts` and are NEVER
 * re-exported here: the lake and the indexer take the grammar as a value and
 * read through the Store, so this entry parses every harness without naming
 * one.
 *
 * This entry is OPEN (the server builds its memory lake over it, the daemon
 * its transcript plane), so there is no `export *` here and there may never
 * be one: `manifest-open-entrypoint` holds the surface enumerable, exactly as
 * for `@podium/harness/driver`. The sqlite-backed source stays host-only
 * behind `@podium/harness` (the daemon barrel), never here.
 */
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
  sliceItemsByAnchor,
} from './store/source.js'
export type {
  TranscriptRecordMapper,
  TranscriptSource,
} from './store/source.js'
export {
  transcriptSourceFromGrammar,
} from './store/store.js'
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
  TranscriptColorReader,
  TranscriptTailMeta,
  TranscriptTailOptions,
  TranscriptTailStatus,
  TranscriptTailer,
} from './store/tailer.js'
