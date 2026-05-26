import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import {
  buildDesktopStoreCommand,
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
  await mkdir(path.join(workspacePath, 'scripts'), { recursive: true });
  await writeFile(path.join(workspacePath, 'scripts', 'run-electron-builder.js'), 'console.log("stub");\n', 'utf8');
  await writePackageJson(workspacePath, {
    'prepare:runtime': 'node -e "process.exit(0)"',
    'prepare:bundled-toolchain': 'node -e "process.exit(0)"',
    'prepare:code-server-runtime': 'node -e "process.exit(0)"',
    'prepare:omniroute-runtime': 'node -e "process.exit(0)"',
    'build:prod': 'node -e "process.exit(0)"',
    'package:smoke-test': 'node -e "process.exit(0)"',
  });

  const strategy = await resolveDesktopStoreBuildStrategy({
    desktopWorkspace: workspacePath,
  });

  assert.equal(strategy.canBuild, true);
  assert.equal(strategy.isCompatible, true);
  const command = buildDesktopStoreCommand('electron-builder.store.yml', strategy, {
    packerRepoRoot: '/tmp/win_store_packer'
  });
  assert.match(command, /node scripts\/run-electron-builder\.js --win dir --publish never --config electron-builder\.store\.yml/);
  assert.match(command, /package-store-msix\.mjs/);
  assert.match(command, /--input "pkg[\\/]win-unpacked"/);
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
