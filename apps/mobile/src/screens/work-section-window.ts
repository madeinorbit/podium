interface SectionIds {
  readonly key: string
  readonly ids: readonly string[]
}

/** A native List keeps a bounded JS prefix, with its load trigger immediately after that prefix. */
export function workSectionWindow<T extends SectionIds>(
  sources: readonly T[],
  collapsed: ReadonlySet<string>,
  searching: boolean,
  limit: number,
) {
  const sections: { section: T; folded: boolean; visible: readonly string[] }[] = []
  let remaining = limit
  for (const section of sources) {
    const folded = !searching && collapsed.has(section.key)
    if (!folded && section.ids.length > 0 && remaining === 0) return { sections, more: true }
    const visible = folded ? [] : section.ids.slice(0, remaining)
    sections.push({ section, folded, visible })
    remaining -= visible.length
    if (!folded && visible.length < section.ids.length) return { sections, more: true }
  }
  return { sections, more: false }
}
