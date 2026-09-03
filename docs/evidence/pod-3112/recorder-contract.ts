export const CANONICAL_CELL_TITLES = {
  A1A: 'A1a idle send',
  A1B: 'A1b busy send',
  A1C: 'A1c dead send',
  A2A: 'A2a status while working',
  A2B: 'A2b initial idle',
  A3: 'A3 interrupt',
  A4A: 'A4a permissions',
  A4B: 'A4b permissions',
  A5: 'A5 tool transcript',
  A6A: 'A6a views',
  A6B: 'A6b views',
  A7A: 'A7a continuity',
  A7B: 'A7b continuity',
  A8: 'A8 login/error',
  A9: 'A9 kill',
  A10: 'A10 latency',
  A11: 'A11 model/effort',
  BQUOTA: 'Bquota',
  BAUTH: 'Bauth',
} as const

export function canonicalCellTitle(cell: string): string {
  const title = (CANONICAL_CELL_TITLES as Record<string, string>)[cell]
  if (!title) throw new Error('unknown canonical evidence cell: ' + cell)
  return title
}
