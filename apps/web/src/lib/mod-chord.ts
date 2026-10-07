/** Apple hardware: its chords use ⌘ (Meta). Everywhere else they use Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/**
 * The label for a ⌘/Ctrl chord, as the person in front of it would press it: `⌘K` on
 * Apple hardware, `Ctrl+K` on Windows and Linux. Handlers accept Meta on Apple and Ctrl
 * elsewhere; a label that always says ⌘ sends a Windows user looking for a key they lack.
 */
export function modChord(key: string): string {
  if (isApplePlatform()) return `⌘${key}`
  return `Ctrl+${key === '↵' ? 'Enter' : key}`
}
