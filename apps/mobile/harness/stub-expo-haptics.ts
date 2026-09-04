/** Harness-only: a browser has no taptic engine. */
export const ImpactFeedbackStyle = { Light: 'light' } as const
export async function impactAsync(_style?: unknown): Promise<void> {}
