/** The same read-conferring verbs for point lookups and projection passes. */
export function granteesOf(edges: readonly { verb: string; grantee: string }[]): string[] {
  return [
    ...new Set(
      edges
        .filter((edge) => edge.verb === 'read' || edge.verb === 'write' || edge.verb === 'manage')
        .map((edge) => edge.grantee),
    ),
  ]
}
