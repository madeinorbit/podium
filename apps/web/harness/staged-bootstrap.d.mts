/** Types for the harness's staged collection answers (`staged-bootstrap.mjs`). */
export function augmentAnswer(
  records: readonly Record<string, unknown>[],
  fixture: unknown,
  requested?: readonly unknown[],
): { readonly body: string } & Record<string, unknown>
