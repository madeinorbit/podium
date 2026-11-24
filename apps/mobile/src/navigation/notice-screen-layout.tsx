import type { ReactElement } from 'react'
import { ContentActivity } from '../lib/visible-content'

/** The route owns coverage, including sheets beside its screen/surface.
 * Context adds no native wrapper to the scroll-view discovery chain. */
export function noticeScreenLayout({ children }: { children: ReactElement }) {
  return <ContentActivity>{children}</ContentActivity>
}
