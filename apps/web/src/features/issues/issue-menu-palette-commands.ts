import type { PaletteCommand } from '@/app/command-palette'
import { type IssueMenuCommandDeps, runIssueMenuCommand } from './issue-menu-commands'
import { type IssueMenuData, issueMenuEntries, issueMenuEntryLabel } from './issue-menu-config'
import { issueMenuIcon } from './issue-menu-icons'

/**
 * Project the shared menu tree into palette rows without re-declaring actions.
 *
 * These land in their OWN group (`on-task`) with the task named ONCE, in the
 * group's label (POD-745). They used to be `navigate` rows each prefixed with
 * the task title — so one task could put forty rows carrying forty copies of
 * its own title into the same capped bucket as every OTHER task, and win it.
 * The group header says which task these act on; the rows say what they do.
 */
export function issueMenuPaletteCommands(
  data: IssueMenuData,
  deps: IssueMenuCommandDeps,
): PaletteCommand[] {
  return issueMenuEntries(data).flatMap((entry) => {
    const name = issueMenuEntryLabel(entry, data)
    const icon = issueMenuIcon(entry.icon)
    // The task's ref and title stay in `keywords` so typing "POD-745 colour"
    // still finds these rows even though the label no longer repeats them.
    const shared = ['task', 'issue', data.first.title, name]
    if (entry.kind === 'action') {
      return [
        {
          id: `issue-menu:${data.first.id}:${entry.id}`,
          group: 'on-task' as const,
          label: name,
          keywords: shared,
          icon,
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
        group: 'on-task' as const,
        label: `${name} · ${option.label}`,
        keywords: [...shared, option.label],
        hint: option.hint,
        icon,
        run: () => {
          void runIssueMenuCommand(data, entry, option.value, deps)
        },
      }))
  })
}
