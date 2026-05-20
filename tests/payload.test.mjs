import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolveRuntimeRoot, validateServerPayloadRoot } from '../scripts/lib/payload.mjs';

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
