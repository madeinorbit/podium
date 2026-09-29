/**
 * THE TASK-DELETE CONFIRM, IN ONE PLACE.
 *
 * Deleting a task cascades to every agent on it (`IssueSessionLifecycle.deleteIssue`
 * tombstones the issue AND its member sessions), so the confirm must name what goes —
 * the same sentence the desktop's sidebar row menu uses (POD-1077), via the same
 * `describeCascade` arithmetic. Three phone surfaces delete tasks (the Work
 * long-press, the task page overflow, the draft chat's Delete); all three read this
 * module so their wording cannot drift into different ways of stating the same loss.
 */
export const DELETE_TASK_TITLE = 'Delete this task?'

export function describeCascade(taskCount: number, sessionCount: number): string {
  const tasks = `${taskCount} task${taskCount === 1 ? '' : 's'}`
  if (sessionCount === 0) return `This affects ${tasks}.`
  return `This affects ${tasks} and ${sessionCount} agent${sessionCount === 1 ? '' : 's'}.`
}

export function deleteTaskSubtitle(sessionCount: number): string {
  return `${describeCascade(1, sessionCount)} Tasks and sessions can be restored; running agents will be stopped.`
}
