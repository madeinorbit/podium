export function filterPropertyOptions<T extends { label: string }>(
  options: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter((o) => o.label.toLowerCase().includes(q))
}

/**
 * Consecutive runs of the same group (undefined is its own run).
 *
 * `groupKey` splits the runs when present, so a caller can separate options
 * with a rule WITHOUT naming the section; `group` both splits and names. The
 * returned `group` is only ever the heading — a keyed run reports none.
 */
export function groupPropertyOptions<T extends { group?: string; groupKey?: string }>(
  options: T[],
): { group?: string; options: T[] }[] {
  const groups: { key?: string; group?: string; options: T[] }[] = []
  for (const option of options) {
    const key = option.groupKey ?? option.group
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.options.push(option)
    else groups.push({ key, group: option.group, options: [option] })
  }
  return groups.map(({ group, options: members }) => ({ group, options: members }))
}
