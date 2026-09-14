/**
 * Return a standalone environment snapshot for a real child process in a test.
 *
 * Bun's Node-compatible child-process layer can retain the environment that existed when a
 * Vitest worker was created: later writes to `process.env` are not a reliable child-process
 * boundary. Callers that need the hermetic setup must pass this copy as the child `env` option;
 * mutating `process.env` alone is not isolation.
 *
 * This module has no setup side effects. The root test preload re-exports it, while packages
 * whose tsconfig has a package-local root (such as PTY) can import it through the runtime
 * package without pulling the whole root preload into their compile program.
 */
export function hermeticChildEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}
