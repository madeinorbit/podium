import { createElement } from 'react'

export function ArtifactVideo({
  url,
  label,
}: {
  url: string
  bearer: string | null
  label: string
}) {
  return createElement('video', {
    src: url,
    controls: true,
    autoPlay: true,
    'aria-label': label,
    style: { width: '100%', height: '100%', backgroundColor: '#000' },
  })
}
