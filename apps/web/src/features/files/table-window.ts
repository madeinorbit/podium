const MAX_ROWS = 500
const MAX_COLUMNS = 50
const MAX_CELLS = 5_000

/** Keep table previews useful without letting very wide exports create thousands
 * of DOM nodes per row. Filtering still considers the complete document. */
export function tableRenderWindow(
  rowCount: number,
  columnCount: number,
): { rows: number; columns: number } {
  const columns = Math.min(Math.max(0, columnCount), MAX_COLUMNS)
  if (columns === 0) return { rows: 0, columns: 0 }
  return {
    rows: Math.min(Math.max(0, rowCount), MAX_ROWS, Math.floor(MAX_CELLS / columns)),
    columns,
  }
}
