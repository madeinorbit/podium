// Side-effect CSS imports (e.g. xterm's stylesheet) carry no types; the bundler
// (vite for the app, esbuild for the dist build) handles the actual import.
declare module '*.css'
