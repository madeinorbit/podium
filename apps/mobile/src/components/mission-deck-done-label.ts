/** "154 Completed", or the phases when only folded phases hold done work. */
export function doneHiddenLabel(done: { tasks: number; phases: number }): string {
  if (done.tasks) return `${done.tasks} Completed`
  return `${done.phases} ${done.phases === 1 ? 'Phase' : 'Phases'} Completed`
}
