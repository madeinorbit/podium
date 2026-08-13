export function filterPropertyOptions<T extends { label: string }>(
  options: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter((o) => o.label.toLowerCase().includes(q))
}

/** Consecutive runs of the same `group` (undefined is its own run). */
export function groupPropertyOptions<T extends { group?: string }>(
  options: T[],
): { group?: string; options: T[] }[] {
  const groups: { group?: string; options: T[] }[] = []
  for (const option of options) {
    const last = groups[groups.length - 1]
    if (last && last.group === option.group) last.options.push(option)
    else groups.push({ group: option.group, options: [option] })
  }
  return groups
}
