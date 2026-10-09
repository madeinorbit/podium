/** Keep ten viewports ready on either side without letting the default
 * 50ms batching delay fall behind a fling. All windows remain bounded. */
export const listWindow = {
  initialNumToRender: 32,
  maxToRenderPerBatch: 48,
  updateCellsBatchingPeriod: 16,
  windowSize: 21,
  scrollEventThrottle: 16,
} as const
