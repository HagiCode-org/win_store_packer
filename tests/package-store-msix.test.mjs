import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArgs } from '../scripts/package-store-msix.mjs';

test('parseArgs strips wrapping quotes from Windows shell argument values', async () => {
  const projectRoot = path.resolve('/tmp/win-store-packer');
  const options = parseArgs([
    '--project-root',
    `"${projectRoot}"`,
    '--config',
    '"electron-builder.store.unsigned.yml"',
    '--input',
    '"pkg/win-unpacked"',
    '--output',
    '"pkg"',
    '--stage',
    '"build/msix-stage"',
    '--assets',
    '"resources/appx"',
  ]);

  assert.equal(options.projectRoot, projectRoot);
  assert.equal(options.config, 'electron-builder.store.unsigned.yml');
  assert.equal(options.input, 'pkg/win-unpacked');
  assert.equal(options.output, 'pkg');
  assert.equal(options.stage, 'build/msix-stage');
  assert.equal(options.assets, 'resources/appx');
  assert.equal(options.configPath, path.resolve(projectRoot, 'electron-builder.store.unsigned.yml'));
  assert.equal(options.inputPath, path.resolve(projectRoot, 'pkg/win-unpacked'));
  assert.equal(options.outputPath, path.resolve(projectRoot, 'pkg'));
  assert.equal(options.stagePath, path.resolve(projectRoot, 'build/msix-stage'));
  assert.equal(options.assetsPath, path.resolve(projectRoot, 'resources/appx'));
});
