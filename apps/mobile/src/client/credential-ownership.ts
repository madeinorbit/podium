/** Serializes SecureStore mutations whose completion can outlive a profile. */
export class CredentialWriteQueue {
  private tail = Promise.resolve()

  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release = () => {}
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }
}

export class StaleCredentialOwnerError extends Error {
  constructor() {
    super('This sign-in belongs to a server profile that is no longer active.')
    this.name = 'StaleCredentialOwnerError'
  }
}

/**
 * Replace one profile's credential only while its captured ownership token is
 * current. If ownership moves during the asynchronous write, restore the prior
 * value before releasing the serialized queue to the newer operation.
 */
export async function replaceCredentialForOwner(args: {
  token: string | null
  isCurrent(): boolean
  read(): Promise<string | null>
  write(token: string): Promise<void>
  remove(): Promise<void>
}): Promise<void> {
  if (!args.isCurrent()) throw new StaleCredentialOwnerError()
  const prior = await args.read()
  if (!args.isCurrent()) throw new StaleCredentialOwnerError()

  if (args.token) await args.write(args.token)
  else await args.remove()
  if (args.isCurrent()) return

  if (prior) await args.write(prior)
  else await args.remove()
  throw new StaleCredentialOwnerError()
}
