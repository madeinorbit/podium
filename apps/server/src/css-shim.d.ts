// Side-effect CSS imports carry no types; the bundler handles the actual
// import. The terminal mount integration tests import the terminal-client
// barrel, which reaches the terminal view's xterm stylesheet (POD-5614).
// Production server code imports no CSS, so this changes nothing it checks.
declare module '*.css'
