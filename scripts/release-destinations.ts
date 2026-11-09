/** An accepted candidate can reach the mirror even when GitHub publication fails. */
export function publishReleaseDestinations(github: () => void, mirror: () => void): void {
  const errors: unknown[] = []
  try {
    github()
  } catch (error) {
    errors.push(error)
  }
  try {
    mirror()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'release publication failed')
}
