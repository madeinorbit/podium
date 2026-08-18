import { IssueScreen } from '../../src/screens/IssueScreen'

/**
 * `/issue/[id]` IS A SCREEN AGAIN [POD-724].
 *
 * POD-592 turned this route into a `Redirect` to `/mission/[id]` on the grounds
 * that "there is no second full-screen task page any more" — the deck's sheet
 * showed more than the flat page did. That was true of the flat page: a chip
 * row, a description, a session list and comments. It is not true of the page
 * this route now renders, which carries the desktop task page's banners, status
 * strip, live-agent block, filled long-form spec fields, published artifacts,
 * sub-tasks, mail, properties and interleaved activity feed.
 *
 * The two routes answer DIFFERENT questions and both are wanted: `/mission/[id]`
 * is the fleet view of a body of work (the deck, its children, who is on them);
 * `/issue/[id]` is one task's own record. The Tasks tab opens tasks here; the
 * Work tab still opens missions there.
 *
 * The redirect was also load-bearing in a way it did not intend: `<Redirect>`
 * drops the query string, so `/issue/x?demo=1` arrived at `/mission/x` with demo
 * mode OFF, the app tried to reach a server that was not there, and the fixture
 * world came up as a boot failure.
 */
export default IssueScreen
