/**
 * A mode change must make the native shell re-read config. Plain browsers have
 * no host process to restart, so their equivalent is a page reload.
 */
export async function restartPodiumShell(): Promise<void> {
  const restart = (window as unknown as { __PODIUM_RESTART__?: () => unknown }).__PODIUM_RESTART__
  if (restart) {
    await Promise.resolve(restart())
    return
  }
  window.location.reload()
}
