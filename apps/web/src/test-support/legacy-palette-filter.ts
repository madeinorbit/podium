import { GROUP_CAP, isResting, scoreCommand, type PaletteCommand, type PaletteGroup, type PaletteGroupId } from '@/app/command-palette'

// Frozen pre-migration ranking and capping oracle.
const GROUP_ORDER: PaletteGroupId[] = ['recent', 'task', 'agent', 'place', 'on-task', 'on-agent', 'action']
export function legacyFilterCommands(query: string, commands: PaletteCommand[]): PaletteGroup[] {
  const resting = isResting(query)
  const scored = commands
    .map((cmd, order) => ({ cmd, order, score: scoreCommand(query, cmd) }))
    .filter((s) => s.score > 0)
  const groups: PaletteGroup[] = []
  for (const group of GROUP_ORDER) {
    const cap = resting ? GROUP_CAP[group].rest : GROUP_CAP[group].query
    if (cap <= 0) continue
    const mine = scored
      .filter((s) => s.cmd.group === group)
      .sort((a, b) => b.score - a.score || a.order - b.order)
    const best = mine[0]
    if (!best) continue
    groups.push({
      group,
      commands: mine.slice(0, cap).map((s) => s.cmd),
      total: mine.length,
      top: best.score,
    })
  }
  if (!resting) {
    groups.sort(
      (a, b) => b.top - a.top || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
    )
  }
  return groups
}

