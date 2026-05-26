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
  artifactVariant = 'signed',
  requireSigned = false
}) {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const normalizedVariant = String(artifactVariant ?? 'signed').trim().toLowerCase();
  const buildMetadataPath = path.join(resolvedWorkspacePath, `build-metadata-${platformId}-${normalizedVariant}.json`);
  const artifactInventoryPath = path.join(resolvedWorkspacePath, `artifact-inventory-${platformId}-${normalizedVariant}.json`);
  const buildMetadata = await readJson(buildMetadataPath);
  const artifactInventory = await readJson(artifactInventoryPath);

  if (normalizedVariant !== 'signed') {
    await appendSummary([
      `### AppX signing finalization skipped for ${platformId} (${normalizedVariant})`,
      '- Variant does not require signature verification.'
    ]);
    return {
      signedArtifactPath: null,
      buildMetadataPath,
      artifactInventoryPath
    };
  }

  if (!buildMetadata.signing?.enabled) {
    await appendSummary([
      `### AppX signing skipped for ${platformId}`,
      '- Signing mode: disabled',
      `- Published artifact: ${path.basename(buildMetadata.publishedArtifactPath)}`
    ]);
    return {
      signedArtifactPath: null,
      buildMetadataPath,
      artifactInventoryPath
    };
  }

  const signedArtifactPath = buildMetadata.publishedArtifactPath;
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

  const finalArtifactSigningExpected = buildMetadata.signing?.finalArtifactSigningExpected !== false;
  const signingStatus = finalArtifactSigningExpected
    ? 'signed-verified'
    : 'content-signed-package-unsigned';

  if (finalArtifactSigningExpected) {
    await verifySignedArtifact(buildMetadata.signing.verificationScriptPath, signedArtifactPath);
  }

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
      storePackageExtension: buildMetadata.storePackageExtension,
      variant: 'signed',
      signed: true,
      contentSigned: true,
      finalArtifactSigned: finalArtifactSigningExpected,
      primaryForStoreSubmission: false
    }
  });

  artifactInventory.artifacts = [signedArtifactRecord];
  artifactInventory.signing = {
    ...artifactInventory.signing,
    finalized: true,
    status: signingStatus
  };

  buildMetadata.signing = {
    ...buildMetadata.signing,
    status: signingStatus
  };

  await writeJson(buildMetadataPath, buildMetadata);
  await writeJson(artifactInventoryPath, artifactInventory);

  await appendSummary(
    finalArtifactSigningExpected
      ? [
          `### AppX signing finalized for ${platformId}`,
          `- Signed sideload artifact: ${path.basename(signedArtifactPath)}`,
          `- Store package version: ${buildMetadata.storePackageVersion}`
        ]
      : [
          `### Store package signing finalized for ${platformId}`,
          `- Signed-content artifact: ${path.basename(signedArtifactPath)}`,
          '- Final package Authenticode signing intentionally skipped.',
          '- Electron Builder still signed embedded Windows binaries before packaging.'
        ]
  );

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
      'artifact-variant': { type: 'string' },
      'require-signed': { type: 'boolean' }
    }
  });

  if (!values.workspace || !values.platform) {
    throw new Error('finalize-appx-signing requires --workspace and --platform.');
  }

  const result = await finalizeAppxSigning({
    workspacePath: values.workspace,
    platformId: values.platform,
    artifactVariant: values['artifact-variant'] ?? 'signed',
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
