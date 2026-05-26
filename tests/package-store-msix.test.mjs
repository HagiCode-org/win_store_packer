import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildWindowsShellCommand, parseArgs } from '../scripts/package-store-msix.mjs';

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

test('buildWindowsShellCommand quotes executable arguments with spaces for cmd.exe', async () => {
  const command = buildWindowsShellCommand('npx.cmd', [
    '--yes',
    '@microsoft/winappcli@0.3.1',
    'package',
    'D:/tmp/msix-stage/app',
    '--manifest',
    'D:/tmp/msix-stage/app/Package.appxmanifest',
    '--output',
    'D:/tmp/pkg',
    '--name',
    'Hagicode-0.1.57.0-x64.msix',
    '--executable',
    'Hagicode Desktop.exe',
  ]);

  assert.ok(command.startsWith('npx.cmd --yes @microsoft/winappcli@0.3.1 package D:/tmp/msix-stage/app'));
  assert.match(command, /--executable "Hagicode Desktop.exe"$/);
});
