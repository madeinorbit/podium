/** Haptics are not what a screenshot reviews, and pulling in `expo-haptics`
 *  drags `expo-modules-core`'s native TS declarations into the harness bundle. */
export const ImpactFeedbackStyle = { Light: 'light' } as const
export async function impactAsync(): Promise<void> {}
