/**
 * Repos offered after a machine is chosen on the new-work sheet.
 *
 * A repo with no machine records is the ordinary local-daemon case — it is
 * available on every host. Once two or more machines exist, a repo that lists
 * hosts is kept only when the selected one is among them.
 */
export function reposOnMachine<R extends { machines?: { machineId: string }[] }>(
  repos: readonly R[],
  machineId: string | null,
  machineCount: number,
): R[] {
  if (!machineId || machineCount <= 1) return [...repos]
  return repos.filter((repo) => {
    const hosts = repo.machines ?? []
    if (hosts.length === 0) return true
    return hosts.some((host) => host.machineId === machineId)
  })
}
