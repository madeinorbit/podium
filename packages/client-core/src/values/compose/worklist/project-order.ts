import type { UnifiedWorkGroup } from './folds'
import type { RepoNavView, SidebarSections } from './nav'

/** One visible project, including paths that an older saved order may use. */
export interface SidebarProject {
  key: string
  name: string
  aliases: string[]
}

function identities(repo: RepoNavView): string[] {
  return [repo.repoId, repo.path, ...(repo.machines?.map((machine) => machine.path) ?? [])].filter(
    (value): value is string => value !== undefined,
  )
}

/**
 * Build the project list from repository feed order, then append groups
 * whose repository is no longer registered. Work within a project never changes
 * this base order. Saved entries may be repoIds or paths from the older setting.
 */
export function orderedSidebarProjects(
  sections: SidebarSections,
  groups: readonly UnifiedWorkGroup[],
  savedOrder: readonly string[],
): SidebarProject[] {
  const projects: SidebarProject[] = [...sections.pinnedRepos, ...sections.repos].map((repo) => ({
    key: repo.repoId ?? repo.path,
    name: repo.name,
    aliases: identities(repo),
  }))

  for (const group of [...groups].sort((a, b) => a.key.localeCompare(b.key))) {
    const project = projects.find((item) => item.aliases.includes(group.key))
    if (!project) {
      projects.push({ key: group.key, name: group.label, aliases: [group.key] })
    }
  }

  const remaining = new Set(projects)
  const ordered: SidebarProject[] = []
  for (const savedKey of savedOrder) {
    const project = projects.find((item) => remaining.has(item) && item.aliases.includes(savedKey))
    if (!project) continue
    ordered.push(project)
    remaining.delete(project)
  }
  for (const project of projects) {
    if (remaining.has(project)) ordered.push(project)
  }
  return ordered
}

/** Sort populated and empty bands by project identity, never by task order. */
export function orderProjectItems<T>(
  items: readonly T[],
  projects: readonly SidebarProject[],
  keyOf: (item: T) => string,
): T[] {
  const position = new Map<string, number>()
  projects.forEach((project, index) => {
    project.aliases.forEach((alias) => position.set(alias, index))
  })
  return [...items].sort(
    (a, b) => (position.get(keyOf(a)) ?? Infinity) - (position.get(keyOf(b)) ?? Infinity),
  )
}

export function orderProjectGroups(
  groups: readonly UnifiedWorkGroup[],
  projects: readonly SidebarProject[],
): UnifiedWorkGroup[] {
  return orderProjectItems(groups, projects, (group) => group.key)
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
