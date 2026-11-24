import { deferredUntilFirstRoute } from '../../../src/client/deferred-tab'
import { IssuesScreen } from '../../../src/screens/IssuesScreen'

// Off screen at launch, this tab renders after the first route's layout (POD-2666).
export default deferredUntilFirstRoute(IssuesScreen)
