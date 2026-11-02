export function saveWorkNavigation(update: () => void, navigate: () => void) {
  update()
  navigate()
}

/** UIKit owns focus restoration for its navigation stack. */
export function restoreWorkFocus(_id?: string) {
  return true
}
