#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createArtifactRecord } from './lib/artifacts.mjs';
import { runCommand } from './lib/command.mjs';
import { pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

async function verifySignedArtifact(verificationScriptPath, artifactPath) {
  await runCommand('node', [verificationScriptPath, artifactPath], {
    env: {
      ...process.env,
      VERIFY_STRICT: 'true'
    }
  });
}

export async function finalizeAppxSigning({
  workspacePath,
  platformId,
  requireSigned = false
}) {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const buildMetadataPath = path.join(resolvedWorkspacePath, `build-metadata-${platformId}.json`);
  const artifactInventoryPath = path.join(resolvedWorkspacePath, `artifact-inventory-${platformId}.json`);
  const buildMetadata = await readJson(buildMetadataPath);
  const artifactInventory = await readJson(artifactInventoryPath);

  if (!buildMetadata.signing?.enabled) {
    await appendSummary([
      `### AppX signing skipped for ${platformId}`,
      '- Signing mode: disabled',
      `- Primary Store submission artifact: ${path.basename(buildMetadata.artifacts.unsigned)}`
    ]);
    return {
      signedArtifactPath: null,
      buildMetadataPath,
      artifactInventoryPath
    };
  }

  const signedArtifactPath = buildMetadata.signing.stagedSignedArtifactPath;
  if (!signedArtifactPath || !(await pathExists(signedArtifactPath))) {
    if (requireSigned || buildMetadata.signing.required) {
      throw new Error(`Missing signed AppX artifact for ${platformId} at ${signedArtifactPath ?? '[unset]'}.`);
    }

    return {
      signedArtifactPath: null,
      buildMetadataPath,
      artifactInventoryPath
    };
  }

  await verifySignedArtifact(buildMetadata.signing.verificationScriptPath, signedArtifactPath);

  const signedArtifactRecord = await createArtifactRecord({
    artifactPath: signedArtifactPath,
    platformId,
    metadata: {
      distributionMode: buildMetadata.distributionMode,
      runtimeSource: buildMetadata.runtimeSource,
      desktopVersion: buildMetadata.desktopVersion,
      desktopTag: buildMetadata.desktopTag,
      desktopRef: buildMetadata.desktopRef,
      serverVersion: buildMetadata.serverVersion,
      storePackageVersion: buildMetadata.storePackageVersion,
      variant: 'signed',
      signed: true,
      primaryForStoreSubmission: false
    }
  });

  artifactInventory.artifacts = [
    ...artifactInventory.artifacts.filter((artifact) => artifact.variant !== 'signed'),
    signedArtifactRecord
  ];
  artifactInventory.signing = {
    ...artifactInventory.signing,
    finalized: true
  };

  buildMetadata.signing = {
    ...buildMetadata.signing,
    status: 'signed-verified'
  };

  await writeJson(buildMetadataPath, buildMetadata);
  await writeJson(artifactInventoryPath, artifactInventory);

  await appendSummary([
    `### AppX signing finalized for ${platformId}`,
    `- Signed sideload artifact: ${path.basename(signedArtifactPath)}`,
    `- Primary Store submission artifact: ${path.basename(buildMetadata.artifacts.unsigned)}`,
    `- Store package version: ${buildMetadata.storePackageVersion}`
  ]);

  return {
    signedArtifactPath,
    buildMetadataPath,
    artifactInventoryPath
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      platform: { type: 'string' },
      'require-signed': { type: 'boolean' }
    }
  });

  if (!values.workspace || !values.platform) {
    throw new Error('finalize-appx-signing requires --workspace and --platform.');
  }

  const result = await finalizeAppxSigning({
    workspacePath: values.workspace,
    platformId: values.platform,
    requireSigned: values['require-signed'] ?? false
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## AppX signing finalization failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
