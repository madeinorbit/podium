
/** One visible project, including paths that an older saved order may use. */
export interface SidebarProject {
  key: string
  name: string
  aliases: string[]
}

/** Reorder visible projects without losing saved slots hidden by machine scope. */
export function mergeVisibleProjectOrder(
  visible: readonly SidebarProject[],
  savedOrder: readonly string[],
): string[] {
  const visibleByAlias = new Map<string, string>()
  for (const project of visible) {
    for (const alias of project.aliases) {
      if (!visibleByAlias.has(alias)) visibleByAlias.set(alias, project.key)
    }
  }

  const seen = new Set<string>()
  const slots: Array<{ hidden: string } | { visible: true }> = []
  for (const savedKey of savedOrder) {
    const visibleKey = visibleByAlias.get(savedKey)
    if (visibleKey === undefined) {
      slots.push({ hidden: savedKey })
    } else if (!seen.has(visibleKey)) {
      slots.push({ visible: true })
      seen.add(visibleKey)
    }
  }

  let next = 0
  const merged = slots.map((slot) => {
    if ('hidden' in slot) return slot.hidden
    const project = visible[next++]
    if (!project) throw new Error('Visible project order has fewer entries than saved slots')
    return project.key
  })
  return [...merged, ...visible.slice(next).map((project) => project.key)]
}
