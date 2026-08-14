import { realpathSync } from 'node:fs'

export type ProvisionedAccountHomeSource = 'configured' | 'named-instance' | 'test-override'

export interface ProvisionedAccountHome {
  path: string
  source: ProvisionedAccountHomeSource
}

/** Resolve both sides through the filesystem so aliases and symlinks cannot
 * make the ambient operator HOME look like an isolated native-account root. */
export function provisionedAccountHome(input: {
  path: string
  source: ProvisionedAccountHomeSource
  ambientHome: string
  realpath?: (path: string) => string
}): ProvisionedAccountHome | undefined {
  const realpath = input.realpath ?? ((path: string) => realpathSync.native(path))
  let path: string
  let ambientHome: string
  try {
    path = realpath(input.path)
    ambientHome = realpath(input.ambientHome)
  } catch {
    return undefined
  }
  if (path === ambientHome) return undefined
  return { path, source: input.source }
}
