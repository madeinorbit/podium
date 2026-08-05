export type ReleaseNotes = { summary: string }

const VERSION_HEADING = /^##[ \t]+(.+?)[ \t]*$/gm

function headingVersion(title: string): string | undefined {
  const bracketed = title.match(/^\[([^\]]+)\]/)
  if (bracketed) return bracketed[1]

  const plain = title.match(/^(\S+)/)
  return plain?.[1]
}

/** Extract the Keep a Changelog section for one released version. */
export function extractRelease(markdown: string, version: string): ReleaseNotes | null {
  if (version.toLowerCase() === 'unreleased') return null

  const headings = [...markdown.matchAll(VERSION_HEADING)]
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (!heading) continue
    if (headingVersion(heading[1] ?? '') !== version) continue

    const headingStart = heading.index ?? 0
    const sectionStart = headingStart + heading[0].length
    const sectionEnd = headings[index + 1]?.index ?? markdown.length
    const summary = markdown.slice(sectionStart, sectionEnd).trim()
    return summary ? { summary } : null
  }

  return null
}
