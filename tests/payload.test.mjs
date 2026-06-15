import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  resolveRuntimeRoot,
  resolveStructuredDlcPayloadRoot,
  stageStructuredDlcPayload,
  validateServerPayloadRoot,
  validateStructuredDlcPayloadRoot,
} from '../scripts/lib/payload.mjs';
import { readJson } from '../scripts/lib/fs-utils.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixturePath(...segments) {
  return path.join(repoRoot, 'tests', 'fixtures', ...segments);
}

test('validateServerPayloadRoot accepts a complete payload tree', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-payload-'));
  await mkdir(path.join(tempRoot, 'config'), { recursive: true });
  await mkdir(path.join(tempRoot, 'lib'), { recursive: true });
  await writeFile(path.join(tempRoot, 'manifest.json'), '{}');
  await writeFile(path.join(tempRoot, 'lib', 'PCode.Web.dll'), 'fixture');
  await writeFile(path.join(tempRoot, 'lib', 'PCode.Web.runtimeconfig.json'), '{}');
  await writeFile(path.join(tempRoot, 'lib', 'PCode.Web.deps.json'), '{}');

  const runtimeRoot = await resolveRuntimeRoot(tempRoot);
  const validation = await validateServerPayloadRoot(runtimeRoot, 'win-x64');
  assert.equal(validation.runtimeRoot, tempRoot);
  assert.ok(validation.requiredPaths.includes('lib/PCode.Web.dll'));
});

test('validateServerPayloadRoot reports missing required files', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-payload-missing-'));
  await mkdir(path.join(tempRoot, 'lib'), { recursive: true });
  await writeFile(path.join(tempRoot, 'manifest.json'), '{}');
  await writeFile(path.join(tempRoot, 'lib', 'PCode.Web.dll'), 'fixture');

  await assert.rejects(
    () => validateServerPayloadRoot(tempRoot, 'win-x64'),
    /Missing: config, lib\/PCode\.Web\.runtimeconfig\.json, lib\/PCode\.Web\.deps\.json/
  );
});

test('validateStructuredDlcPayloadRoot accepts the managed Turbo Engine DLC fixture', async () => {
  const structuredDlcRoot = await resolveStructuredDlcPayloadRoot(
    fixturePath('turbo-engine-dlc-package'),
    { directoryId: 'turbo-engine' }
  );

  assert.ok(structuredDlcRoot?.endsWith(path.join('lib', 'dlcs', 'turbo-engine')));

  const validation = await validateStructuredDlcPayloadRoot(structuredDlcRoot, {
    platformId: 'win-x64',
    directoryId: 'turbo-engine',
    dlcId: 'pcode.turbo-engine',
    packageFileName: 'hagicode-dlc-turbo-engine-1.0.0-win-x64-nort.zip',
  });

  assert.equal(validation.dlcId, 'pcode.turbo-engine');
  assert.equal(validation.version, '1.0.0');
  assert.equal(validation.entryAssembly, 'PCode.ConcurrencyExtensionDlc.dll');
  assert.equal(validation.manifestPath, 'turbo-engine/dlc.json');
  assert.equal(validation.filesManifestPath, 'turbo-engine/manifest.files.json');
});

test('validateStructuredDlcPayloadRoot reports missing structured DLC files', async () => {
  const structuredDlcRoot = await resolveStructuredDlcPayloadRoot(
    fixturePath('turbo-engine-dlc-invalid'),
    { directoryId: 'turbo-engine' }
  );

  await assert.rejects(
    () => validateStructuredDlcPayloadRoot(structuredDlcRoot, {
      platformId: 'win-x64',
      directoryId: 'turbo-engine',
      dlcId: 'pcode.turbo-engine',
      packageFileName: 'hagicode-dlc-turbo-engine-1.0.0-win-x64-nort.zip',
    }),
    /missing manifest\.files\.json/
  );
});

test('stageStructuredDlcPayload replaces stale runtime DLC content and writes lib/dlcs/index.json', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-dlc-stage-'));
  const runtimeRoot = path.join(tempRoot, 'runtime-root');
  await cp(fixturePath('server-payload'), runtimeRoot, { recursive: true });
  await mkdir(path.join(runtimeRoot, 'lib', 'dlcs', 'turbo-engine'), { recursive: true });
  await writeFile(path.join(runtimeRoot, 'lib', 'dlcs', 'turbo-engine', 'obsolete.txt'), 'stale');
  await writeFile(path.join(runtimeRoot, 'lib', 'dlcs', 'index.json'), '{"stale":true}');

  const structuredDlcRoot = await resolveStructuredDlcPayloadRoot(
    fixturePath('turbo-engine-dlc-package'),
    { directoryId: 'turbo-engine' }
  );
  const validation = await validateStructuredDlcPayloadRoot(structuredDlcRoot, {
    platformId: 'win-x64',
    directoryId: 'turbo-engine',
    dlcId: 'pcode.turbo-engine',
    packageFileName: 'hagicode-dlc-turbo-engine-1.0.0-win-x64-nort.zip',
  });

  const staged = await stageStructuredDlcPayload({
    runtimeRoot,
    dlcRoot: structuredDlcRoot,
    dlcConfig: {
      directoryId: 'turbo-engine',
      runtimeTargetPath: 'lib/dlcs/turbo-engine',
      runtimeIndexPath: 'lib/dlcs/index.json',
      manifestFileName: 'dlc.json',
      filesManifestFileName: 'manifest.files.json',
    },
    validation,
    generatedAt: '2026-06-15T00:00:00.000Z',
  });

  assert.equal(staged.runtimeTargetPath, 'lib/dlcs/turbo-engine');
  assert.equal(staged.runtimeIndexPath, 'lib/dlcs/index.json');
  assert.match(
    await readFile(path.join(runtimeRoot, 'lib', 'dlcs', 'turbo-engine', 'PCode.ConcurrencyExtensionDlc.dll'), 'utf8'),
    /fixture-dlc-entry/
  );
  await assert.rejects(() => readFile(path.join(runtimeRoot, 'lib', 'dlcs', 'turbo-engine', 'obsolete.txt'), 'utf8'));

  const runtimeIndex = await readJson(path.join(runtimeRoot, 'lib', 'dlcs', 'index.json'));
  assert.equal(runtimeIndex.runtimeKey, 'win-x64-nort');
  assert.equal(runtimeIndex.dlcs[0].dlcId, 'pcode.turbo-engine');
  assert.equal(runtimeIndex.dlcs[0].manifestPath, 'turbo-engine/dlc.json');
  assert.equal(runtimeIndex.dlcs[0].filesManifestPath, 'turbo-engine/manifest.files.json');
});
