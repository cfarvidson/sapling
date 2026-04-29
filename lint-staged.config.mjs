// Run a project-wide tsc on whichever package(s) have staged .ts files.
// We return commands without filenames because tsc with -p reads the project's
// own file list; appending paths would conflict with the project flag.
export default {
  'packages/mcp-server/**/*.ts': () => 'pnpm --filter mcp-server typecheck',
  'packages/runner/**/*.ts': () => 'pnpm --filter sapling-runner typecheck',
};
