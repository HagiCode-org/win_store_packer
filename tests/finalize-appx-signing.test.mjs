import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { finalizeAppxSigning } from '../scripts/finalize-appx-signing.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';

test('finalizeAppxSigning skips final package verification when configured to keep the artifact unsigned', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'win-store-finalize-'));
  const artifactPath = path.join(workspacePath, 'fixture-signed.msix');
  const buildMetadataPath = path.join(workspacePath, 'build-metadata-win-x64-signed.json');
  const artifactInventoryPath = path.join(workspacePath, 'artifact-inventory-win-x64-signed.json');

  await writeFile(artifactPath, 'fixture-msix');
  await writeJson(buildMetadataPath, {
    publishedArtifactPath: artifactPath,
    storePackageVersion: '0.3.0.0',
    distributionMode: 'steam',
    runtimeSource: 'portable-fixed',
    desktopVersion: '0.3.0',
    desktopTag: 'v0.3.0',
    desktopRef: 'refs/tags/v0.3.0',
    serverVersion: '0.1.0-beta.34',
    storePackageExtension: '.msix',
    signing: {
      enabled: true,
      required: true,
      finalArtifactSigningExpected: false,
      verificationScriptPath: path.join(workspacePath, 'missing-verify-signature.mjs'),
      status: 'pending-finalization'
    }
  });
  await writeJson(artifactInventoryPath, {
    platform: 'win-x64',
    artifactVariant: 'signed',
    signing: {
      enabled: true,
      required: true,
      status: 'pending-finalization'
    },
    artifacts: []
  });

  await finalizeAppxSigning({
    workspacePath,
    platformId: 'win-x64',
    artifactVariant: 'signed',
    requireSigned: true
  });

  const buildMetadata = await readJson(buildMetadataPath);
  const artifactInventory = await readJson(artifactInventoryPath);

  assert.equal(buildMetadata.signing.status, 'content-signed-package-unsigned');
  assert.equal(artifactInventory.signing.status, 'content-signed-package-unsigned');
  assert.equal(artifactInventory.artifacts[0].signed, true);
  assert.equal(artifactInventory.artifacts[0].finalArtifactSigned, false);
  assert.equal(artifactInventory.artifacts[0].contentSigned, true);
});
