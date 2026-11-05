import { spawnSync } from 'node:child_process';

// Cross-platform LIVE=1 wrapper: no cross-env dependency, no Unix-only syntax.
const result = spawnSync(
  process.execPath,
  ['--test', 'tests/live.test.mjs'],
  { stdio: 'inherit', env: { ...process.env, LIVE: '1' } },
);

process.exit(result.status ?? 1);
