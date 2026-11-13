import { CredentialWriteQueue } from './credential-ownership'

/** Coordinate removal with a mounted replica's writes and asynchronous disposal. */
export function createAccountEraser(eraseClosedPrincipal: (principal: string) => Promise<void>) {
  const owners = new Map<string, { erase(): Promise<void>; seal(): void; closed?: Promise<void> }>()
  return {
    register(
      principal: string,
      replica: {
        erasePrincipalData(): Promise<void>
        dispose(): Promise<void>
        /** Close the principal's device storage to further writes (POD-6908). */
        sealPrincipalData?(): void
      },
    ) {
      const writes = new CredentialWriteQueue()
      const owner = {
        erase: () => writes.run(() => replica.erasePrincipalData()),
        seal: () => replica.sealPrincipalData?.(),
        closed: undefined as Promise<void> | undefined,
      }
      owners.set(principal, owner)
      return {
        dispose(): Promise<void> {
          owner.closed ??= writes
            .run(() => replica.dispose())
            .finally(() => {
              if (owners.get(principal) === owner) owners.delete(principal)
            })
          return owner.closed
        },
      }
    },
    async erase(principal: string): Promise<void> {
      const owner = owners.get(principal)
      // Every erase comes through here: sign-out, removal, a refused account
      // (POD-6910). The screen may still be mounted and writing, and the erase
      // may wait behind queued writes or a disposal; seal now so nothing it
      // writes meanwhile lands in the namespace about to be checked empty.
      owner?.seal()
      if (owner && !owner.closed) return owner.erase()
      await owner?.closed
      await eraseClosedPrincipal(principal)
    },
  }
}
