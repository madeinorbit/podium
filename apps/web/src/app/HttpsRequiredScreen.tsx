import type { HttpsRequiredRefusal } from '@podium/protocol'
import { BootScreen } from './BootScreen'

/** Browser and desktop use the server's refusal before any replica is opened. */
export function HttpsRequiredScreen({ guidance }: { guidance: HttpsRequiredRefusal }) {
  return (
    <BootScreen
      eyebrow="Secure connection required"
      headline="Connect with HTTPS"
      prose={
        <>
          {guidance.message}
          {guidance.httpsUrl && (
            <>
              <br />
              <br />
              <a href={guidance.httpsUrl}>Open {guidance.httpsUrl}</a>
            </>
          )}
          <br />
          <br />
          <a href={guidance.docsUrl} target="_blank" rel="noreferrer">
            HTTPS setup instructions
          </a>
        </>
      }
      fields={guidance.httpsUrl ? [{ label: 'HTTPS address', value: guidance.httpsUrl }] : []}
      panelLabel="HTTPS setup"
      primary={{
        label: guidance.httpsUrl ? 'Open HTTPS address' : 'HTTPS setup instructions',
        onClick: () => window.location.assign(guidance.httpsUrl ?? guidance.docsUrl),
      }}
    />
  )
}
