/** Keep five viewports ready on either side without letting the default
 * 50ms batching delay fall behind a fling. All windows remain bounded. */
export const listWindow = {
  initialNumToRender: 16,
  maxToRenderPerBatch: 24,
  updateCellsBatchingPeriod: 16,
  windowSize: 11,
} as const
