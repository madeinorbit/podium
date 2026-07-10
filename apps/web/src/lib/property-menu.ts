export function filterPropertyOptions<T extends { label: string }>(
  options: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter((o) => o.label.toLowerCase().includes(q))
}
