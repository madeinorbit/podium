/** Only generated relation getters use this boundary; raw model helpers still warn. */
let depth = 0

export const readingModelRelation = (): boolean => depth > 0

export function modelRelationRead<A extends unknown[], T>(
  read: (...args: A) => T,
): (...args: A) => T {
  if (process.env.NODE_ENV === 'production') return read
  return (...args) => {
    depth += 1
    try {
      return read(...args)
    } finally {
      depth -= 1
    }
  }
}
