#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['scripts/build-fixture-appx.mjs', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: 'inherit',
  encoding: 'utf8'
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 0);
