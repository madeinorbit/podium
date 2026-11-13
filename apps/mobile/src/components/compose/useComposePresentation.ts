/** Web and Android do not need to wait for UIKit's sheet bounds animation. */
export function useComposePresentation() {
  return true
}
