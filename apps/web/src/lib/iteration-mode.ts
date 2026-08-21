/**
 * IS THIS PAGE SOURCE, SERVED BY `bun run iterate`?
 *
 * One question, one answer, three readers: the frame that says so
 * (`app/IterationModeFrame.tsx`), the wire guard that must not hard-reload a
 * page a reload cannot fix (`features/setup/version-guard.ts`), and the update
 * surface that must not offer a fleet update from a page that is not the
 * installed app (`features/updates/updates-context.tsx`).
 *
 * It lives in `lib/` because two FEATURES read it and a feature may not import
 * another feature (features/README.md).
 *
 * STRICTLY THE BOOLEAN the define writes (`apps/web/vite.config.ts` emits
 * `JSON.stringify(process.env.PODIUM_ITERATION_MODE === '1')`, so every built
 * dist gets the literal `false`). Anything else — a string, undefined, a value
 * that leaked in from somewhere else — reads as NO. Getting this wrong in the
 * false direction costs a frame nobody sees; getting it wrong in the true
 * direction silently disables the updater on an installed app, which is the
 * failure this project exists to prevent.
 */
export function isIterationMode(
  flag: boolean | undefined = import.meta.env.PODIUM_ITERATION_MODE,
): boolean {
  return flag === true
}
