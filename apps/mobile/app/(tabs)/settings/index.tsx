import { deferredUntilFirstRoute } from '../../../src/client/deferred-tab'
import { SettingsScreen } from '../../../src/screens/SettingsScreen'

// Off screen at launch, this tab renders after the first route's layout (POD-2666).
export default deferredUntilFirstRoute(SettingsScreen)
