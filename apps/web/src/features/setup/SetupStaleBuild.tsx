import { WIRE_VERSION } from '@podium/protocol'
import type { JSX } from 'react'
import { BootScreen } from '@/app/BootScreen'
import type { localBuildStamp } from './local-build-guard'

/**
 * The one screen that refuses to run rather than run wrong.
 *
 * It appears only in the corner the stale guard exists for: the desktop shell fell back to the
 * copy of the interface baked into the app, no server is answering, and that copy is older
 * than the build that last wrote this device's data. Rendering the app here would let old code
 * read — and write back — rows whose shape it has never seen.
 *
 * So the instruction is the one thing that actually fixes it: be online with your server once.
 * There is no retry button that can help from here, which is why the primary action is the
 * reload the user will need AFTER the server is back rather than a "try again" that would
 * simply return to this screen.
 */
export function SetupStaleBuild({
  stamp,
  onRetry,
}: {
  stamp: NonNullable<ReturnType<typeof localBuildStamp>>
  onRetry: () => void
}): JSX.Element {
  return (
    <BootScreen
      eyebrow="Update / required"
      headline={'This copy of Podium\nis too old to open your work.'}
      prose="The app fell back to the interface built into it, and your server is not answering. That built-in copy is older than the data already on this device, so opening it could misread your work. Start your Podium server, or connect this device to it once, and Podium will update itself."
      fields={[
        {
          label: 'Built-in interface',
          value: `wire ${WIRE_VERSION}`,
        },
        {
          label: 'Your data was written by',
          value: stamp.appVersion
            ? `${stamp.appVersion} (wire ${stamp.wireVersion})`
            : `wire ${stamp.wireVersion}`,
          tone: 'fault',
        },
        { label: 'Next check', value: 'podium status', tone: 'command' },
      ]}
      reassurance="nothing on this device has been changed"
      primary={{ label: 'Try again', onClick: onRetry }}
    />
  )
}
