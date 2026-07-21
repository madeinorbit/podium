import { ScrollViewStyleReset } from 'expo-router/html'
import type { PropsWithChildren } from 'react'

/**
 * Custom HTML shell for the web export. `maximum-scale=1` suppresses iOS
 * Safari's auto-zoom on focused inputs under 16px (the app's dense type is
 * 12–13px) — Safari still honours user pinch-zoom gestures, so this costs no
 * accessibility. `viewport-fit=cover` exposes the safe-area env() insets when
 * installed to the home screen.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />
        <meta name="theme-color" content="#0e0e12" />
        <ScrollViewStyleReset />
        <style>{'html, body { background: #0e0e12; }'}</style>
      </head>
      <body>{children}</body>
    </html>
  )
}
