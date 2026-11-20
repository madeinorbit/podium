import type { BuiltinHarnessKind } from '@podium/model'
import { harnessHomeVariable } from '../registry.js'
import { type InstallReleaseOptions, installRelease } from './managed-install.js'

/** Section 4.7, shared by the install action and machine setup for every adapter. */
export function managedInstallRefusal(
  kind: BuiltinHarnessKind,
  externalInstalled: boolean | null,
): string | undefined {
  if (harnessHomeVariable(kind)) return undefined
  if (externalInstalled === null)
    return `Podium could not check whether your own ${kind} install is present. Check the machine again before installing.`
  if (externalInstalled)
    return `Podium cannot install ${kind} alongside your own install: this harness has no folder variable, so both copies would share your settings and conversations.`
  return undefined
}

/** Only a person's install action or the explicit machine-setup --agents request calls this. */
export async function requestManagedInstall(
  kind: BuiltinHarnessKind,
  externalInstalled: boolean | null,
  options: InstallReleaseOptions,
) {
  const refusal = managedInstallRefusal(kind, externalInstalled)
  if (refusal) throw new Error(refusal)
  return await installRelease(kind, options)
}
