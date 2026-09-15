/** HTTP bootstrap records and live WebSocket frames share kernel mappings. */
export { toBootstrapChunk, toDeltaFrame, toRescopeFrame, toResyncFrame } from './frames'
export { FeedSink, type FeedSinkDeps } from './sink'
