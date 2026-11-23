/**
 * WHOSE DEVICE STORES A SIGN-IN OPENS (POD-7312; POD-6954 design 4.2).
 *
 * A device keeps everything it saves for a sign-in under one key the server
 * writes: the sync boundary and the member (`replicaNamespaceKey` in
 * packages/client-core/src/replica/principal-storage.ts). The replica and its
 * cursor, the unsent writes, drafts and screen state, and chat history all
 * live below it, on the web and on the phone. The boundary is therefore what
 * keeps two workspaces apart on one device: it must name the workspace the
 * request is bound to, never something two workspaces share.
 *
 * - Self-hosted: the installation holds one workspace, and its devices have
 *   always keyed by the installation's id (or the composition root's workspace
 *   label). That value stays: a new one would hide every device's saved data
 *   and strand its unsent writes under the old key.
 * - Hosted: the id of the request's bound workspace. There is no fallback to
 *   the installation's id, which every workspace of the installation shares.
 *   Without a bound workspace the server names no boundary, and the device
 *   opens no stores (`classifyAuthStatus` refuses a status without one).
 *
 * The member half alone cannot keep workspaces apart: a membership's member id
 * may be supplied by its creator, so one id can exist in two workspaces.
 */
export type ReplicaBoundaryOf = (request: Request) => string | undefined

export function replicaBoundaryOf(input: {
  /** `ServerCapabilities.installationNamesWorkspace`. */
  readonly installationNamesWorkspace: boolean
  /** Self-hosted: the value this installation's devices already key by. */
  readonly installationBoundary: string
  /** The workspace this request is bound to; absent when it is bound to none. */
  readonly workspaceOf: (request: Request) => string | undefined
}): ReplicaBoundaryOf {
  if (input.installationNamesWorkspace) {
    const boundary = input.installationBoundary
    if (!boundary) throw new Error('a self-hosted installation needs a sync boundary')
    return () => boundary
  }
  return (request) => {
    const workspace = input.workspaceOf(request)
    return workspace ? workspace : undefined
  }
}
