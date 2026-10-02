import { CredentialWriteQueue } from './credential-ownership'

/** Coordinate removal with a mounted replica's writes and asynchronous disposal. */
export function createAccountEraser(eraseClosedPrincipal: (principal: string) => Promise<void>) {
  const owners = new Map<string, { erase(): Promise<void>; closed?: Promise<void> }>()
  return {
    register(
      principal: string,
      replica: { erasePrincipalData(): Promise<void>; dispose(): Promise<void> },
    ) {
      const writes = new CredentialWriteQueue()
      const owner = {
        erase: () => writes.run(() => replica.erasePrincipalData()),
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
      if (owner && !owner.closed) return owner.erase()
      await owner?.closed
      await eraseClosedPrincipal(principal)
    },
  }
}
