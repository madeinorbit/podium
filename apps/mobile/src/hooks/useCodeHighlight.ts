import { type CodeToken, highlightCode } from '@podium/client-core/code-highlight'
import { useEffect, useMemo, useState } from 'react'

/** Keep first paint plain, then colour at idle. The owning block has a stable
 * codeBlockIdentity key, so unrelated renders do not even hash the source again. */
export function useCodeHighlight(source: string, language: string | undefined, enabled = true) {
  const [result, setResult] = useState<{
    source: string
    language: string | undefined
    tokens: readonly CodeToken[]
  } | null>(null)
  useEffect(() => {
    if (!enabled) return
    const highlight = () => setResult({ source, language, tokens: highlightCode(source, language) })
    // RN 0.86 Libraries/Core/setUpTimers.js installs idle callbacks. Older targets
    // still yield the initial render before doing synchronous grammar work.
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(highlight)
      return () => cancelIdleCallback(handle)
    }
    const handle = setTimeout(highlight, 0)
    return () => clearTimeout(handle)
  }, [source, language, enabled])
  const plain = useMemo(() => [{ scope: null, text: source }], [source])
  // Never display a prior streaming revision while its replacement is pending.
  return enabled && result?.source === source && result.language === language
    ? result.tokens
    : plain
}
