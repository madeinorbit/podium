/** Promote a saved capture without discarding independently recorded actions. */
export function promoteSpeedBaseline<
  T extends { sourceSha: string; actions: object; targets: unknown },
>(
  baseline: T,
  report: {
    sourceSha: string
    actions: Partial<T['actions']>
    targets: T['targets']
  },
): T {
  return {
    ...baseline,
    sourceSha: report.sourceSha,
    actions: { ...baseline.actions, ...report.actions },
    targets: report.targets,
  }
}
