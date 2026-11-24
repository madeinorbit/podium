import { deferredUntilFirstRoute } from '../../../src/client/deferred-tab'
import { PulseScreen } from '../../../src/screens/PulseScreen'

// Off screen at launch, this tab renders after the first route's layout (POD-2666).
export default deferredUntilFirstRoute(PulseScreen)
