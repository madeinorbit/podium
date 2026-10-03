import { webPoolSwitch } from '@/lib/mobx-pilot'

/** One app-load latch; the URL override supports the temporary rollback. */
export const issueBoardSwitch = webPoolSwitch('mobxBoard', 'mobxBoardCheck')
export const boardDataLayer = () => issueBoardSwitch.layer()
