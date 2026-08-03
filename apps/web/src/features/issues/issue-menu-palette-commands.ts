import type { PaletteCommand } from '@/app/command-palette'
import { type IssueMenuCommandDeps, runIssueMenuCommand } from './issue-menu-commands'
import { type IssueMenuData, issueMenuEntries, issueMenuEntryLabel } from './issue-menu-config'

/** Project the shared menu tree into palette rows without re-declaring actions. */
export function issueMenuPaletteCommands(
  data: IssueMenuData,
  deps: IssueMenuCommandDeps,
): PaletteCommand[] {
  return issueMenuEntries(data).flatMap((entry) => {
    const prefix = `${data.first.title}: ${issueMenuEntryLabel(entry, data)}`
    if (entry.kind === 'action') {
      return [
        {
          id: `issue-menu:${data.first.id}:${entry.id}`,
          group: 'navigate' as const,
          label: prefix,
          keywords: ['issue', 'task', issueMenuEntryLabel(entry, data)],
          hint: 'Menu',
          run: () => {
            void runIssueMenuCommand(data, entry, undefined, deps)
          },
        },
      ]
    }
    return entry
      .options(data)
      .filter((option) => !option.disabled && !option.empty && option.value !== undefined)
      .map((option) => ({
        id: `issue-menu:${data.first.id}:${entry.id}:${option.value}`,
        group: 'navigate' as const,
        label: `${prefix}: ${option.label}`,
        keywords: ['issue', 'task', issueMenuEntryLabel(entry, data), option.label],
        hint: 'Menu',
        run: () => {
          void runIssueMenuCommand(data, entry, option.value, deps)
        },
      }))
  })
}
