import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import {
  buildDesktopStoreCommand,
  buildDesktopStoreSteps,
  resolveDesktopStoreBuildStrategy,
  shouldUseSyntheticDryRunBuild,
} from '../scripts/lib/desktop-build.mjs';

async function writePackageJson(workspacePath, scripts) {
  await writeFile(
    path.join(workspacePath, 'package.json'),
    `${JSON.stringify({ name: 'desktop-test', version: '0.0.0', scripts }, null, 2)}\n`,
    'utf8'
  );
}

test('resolveDesktopStoreBuildStrategy accepts the current desktop packaging pipeline', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'desktop-build-strategy-pipeline-'));
  await mkdir(path.join(workspacePath, 'config'), { recursive: true });
  await writePackageJson(workspacePath, {
    'build:win:store': 'node scripts/build-store-package.js',
  });
  await writeFile(
    path.join(workspacePath, 'config', 'store-package.json'),
    JSON.stringify({ packageIdentity: { identityName: 'fixture.Hagicode' }, appx: {} }, null, 2),
    'utf8'
  );

  const strategy = await resolveDesktopStoreBuildStrategy({
    desktopWorkspace: workspacePath,
  });

  assert.equal(strategy.canBuild, true);
  assert.equal(strategy.isCompatible, true);

  const steps = buildDesktopStoreSteps(strategy, {
    platform: 'linux'
  });
  assert.equal(steps[0].command, 'npm');
  assert.deepEqual(steps[0].args, ['run', 'build:win:store']);

  const command = buildDesktopStoreCommand(strategy);
  assert.equal(command, 'npm "run" "build:win:store"');

  const windowsCommand = buildDesktopStoreCommand(strategy, {
    platform: 'win32'
  });
  assert.equal(windowsCommand, 'npm.cmd "run" "build:win:store"');
  assert.equal(
    await shouldUseSyntheticDryRunBuild({
      desktopWorkspace: workspacePath,
      planDryRun: true,
    }),
    false
  );
});

test('shouldUseSyntheticDryRunBuild falls back to synthetic packaging when no desktop build path is available', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'desktop-build-strategy-synthetic-'));
  await writePackageJson(workspacePath, {
    build: 'node -e "process.exit(0)"',
  });

  assert.equal(
    await shouldUseSyntheticDryRunBuild({
      desktopWorkspace: workspacePath,
      planDryRun: true,
    }),
    true
  );
});
