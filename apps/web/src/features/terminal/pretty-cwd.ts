/** Collapse the user's home directory to `~` for a compact cwd display. */
export function prettyCwd(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+/, '~')
}
