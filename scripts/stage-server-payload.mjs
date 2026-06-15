#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanDir, ensureDir, readJson, writeJson } from './lib/fs-utils.mjs';
import { resolveAssetDownloadUrl, downloadFromSource, sanitizeUrlForLogs } from './lib/azure-blob.mjs';
import { extractArchive } from './lib/archive.mjs';
import {
  resolveRuntimeRoot,
  resolveStructuredDlcPayloadRoot,
  stageStructuredDlcPayload,
  validateServerPayloadRoot,
  validateStructuredDlcPayloadRoot,
} from './lib/payload.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

const TURBO_ENGINE_DIRECTORY_ID = 'turbo-engine';

export async function stageServerPayload({
  planPath,
  workspacePath,
  platformId,
  serverAssetSource,
  azureSasUrl,
  dlcAssetSource,
  dlcAzureSasUrl,
}) {
  const { plan } = await loadReleasePlan(planPath);
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const workspaceManifest = await readJson(path.join(resolvedWorkspacePath, 'workspace-manifest.json'));
  const serverAsset = plan.upstream.server.assetsByPlatform?.[platformId];
  if (!serverAsset) {
    throw new Error(`No server asset mapped for platform ${platformId}.`);
  }
  const turboEngineConfig = plan.store.dlcs?.[TURBO_ENGINE_DIRECTORY_ID];
  if (!turboEngineConfig) {
    throw new Error(`Release plan is missing required DLC config for ${TURBO_ENGINE_DIRECTORY_ID}.`);
  }
  const turboEngineRelease = plan.upstream.dlcs?.[TURBO_ENGINE_DIRECTORY_ID];
  const turboEngineAsset = turboEngineRelease?.assetsByPlatform?.[platformId];
  if (!turboEngineAsset) {
    throw new Error(`No Turbo Engine DLC asset mapped for platform ${platformId}.`);
  }

  const downloadPath = path.join(workspaceManifest.downloadDirectory, `${platformId}-${serverAsset.name}`);
  const extractionPath = path.join(workspaceManifest.extractDirectory, 'server');
  const dlcDownloadPath = path.join(workspaceManifest.downloadDirectory, `${platformId}-dlc-${turboEngineAsset.name}`);
  const dlcExtractionPath = path.join(workspaceManifest.extractDirectory, TURBO_ENGINE_DIRECTORY_ID);
  await ensureDir(workspaceManifest.downloadDirectory);
  await cleanDir(extractionPath);
  await cleanDir(dlcExtractionPath);

  const assetSource = resolveAssetDownloadUrl({
    asset: serverAsset,
    sasUrl: azureSasUrl,
    overrideSource: serverAssetSource
  });
  const turboEngineAssetSource = resolveAssetDownloadUrl({
    asset: turboEngineAsset,
    sasUrl: dlcAzureSasUrl,
    overrideSource: dlcAssetSource
  });
  await downloadFromSource({ sourceUrl: assetSource, destinationPath: downloadPath });
  await extractArchive(downloadPath, extractionPath);
  await downloadFromSource({ sourceUrl: turboEngineAssetSource, destinationPath: dlcDownloadPath });
  await extractArchive(dlcDownloadPath, dlcExtractionPath);

  const runtimeRoot = await resolveRuntimeRoot(extractionPath);
  if (!runtimeRoot) {
    throw new Error(`Unable to find an extracted server runtime under ${extractionPath}.`);
  }

  const validation = await validateServerPayloadRoot(runtimeRoot, platformId);
  const structuredDlcRoot = await resolveStructuredDlcPayloadRoot(dlcExtractionPath, {
    directoryId: turboEngineConfig.directoryId,
    manifestFileName: turboEngineConfig.manifestFileName,
    filesManifestFileName: turboEngineConfig.filesManifestFileName,
  });
  if (!structuredDlcRoot) {
    throw new Error(`Unable to find an extracted Turbo Engine DLC payload under ${dlcExtractionPath}.`);
  }

  const dlcValidation = await validateStructuredDlcPayloadRoot(structuredDlcRoot, {
    platformId,
    directoryId: turboEngineConfig.directoryId,
    dlcId: turboEngineConfig.dlcId,
    packageFileName: turboEngineAsset.name,
    manifestFileName: turboEngineConfig.manifestFileName,
    filesManifestFileName: turboEngineConfig.filesManifestFileName,
  });
  const stagedDlc = await stageStructuredDlcPayload({
    runtimeRoot: validation.runtimeRoot,
    dlcRoot: structuredDlcRoot,
    dlcConfig: turboEngineConfig,
    validation: dlcValidation,
  });

  const includedDlc = {
    ...stagedDlc,
    sourceArtifact: turboEngineAsset.name,
    assetPath: turboEngineAsset.path ?? null,
    downloadSource: sanitizeUrlForLogs(turboEngineAssetSource),
    downloadPath: dlcDownloadPath,
    extractionPath: dlcExtractionPath,
  };

  const validationReport = {
    validationPassed: true,
    platform: platformId,
    desktopVersion: workspaceManifest.desktopVersion,
    desktopTag: workspaceManifest.desktopTag,
    desktopRef: workspaceManifest.desktopRef,
    serverVersion: workspaceManifest.serverVersion,
    assetName: serverAsset.name,
    assetPath: serverAsset.path ?? null,
    downloadSource: sanitizeUrlForLogs(assetSource),
    downloadPath,
    extractionPath,
    validatedPayloadRoot: validation.runtimeRoot,
    payloadRootForDesktopBuild: validation.runtimeRoot,
    desktopRuntimeInjectionRoot: workspaceManifest.runtimeInjectionRoot,
    requiredPaths: validation.requiredPaths,
    includedDlcs: [includedDlc],
    generatedRuntimeDlcIndexPath: includedDlc.stagedRuntimeIndexPath,
    generatedRuntimeDlcIndexRelativePath: includedDlc.runtimeIndexPath,
  };
  const validationReportPath = path.join(resolvedWorkspacePath, `payload-validation-${platformId}.json`);
  await writeJson(validationReportPath, validationReport);

  await appendSummary([
    `### Server payload staged for ${platformId}`,
    `- Server version: ${workspaceManifest.serverVersion}`,
    `- Desktop tag: ${workspaceManifest.desktopTag}`,
    `- Download source: ${sanitizeUrlForLogs(assetSource)}`,
    `- Validated payload root: ${validation.runtimeRoot}`,
    `- Turbo Engine DLC version: ${includedDlc.version}`,
    `- Turbo Engine DLC source: ${sanitizeUrlForLogs(turboEngineAssetSource)}`,
    `- Turbo Engine DLC target: ${includedDlc.runtimeTargetPath}`,
    `- Desktop runtime injection root: ${workspaceManifest.runtimeInjectionRoot}`
  ]);

  return {
    validationReportPath,
    payloadRootForDesktopBuild: validation.runtimeRoot
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'azure-sas-url': { type: 'string' },
      'server-asset-source': { type: 'string' },
      'dlc-azure-sas-url': { type: 'string' },
      'dlc-asset-source': { type: 'string' }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('stage-server-payload requires --plan, --platform, and --workspace.');
  }

  const result = await stageServerPayload({
    planPath: values.plan,
    workspacePath: values.workspace,
    platformId: values.platform,
    serverAssetSource: values['server-asset-source'],
    azureSasUrl:
      values['azure-sas-url'] ??
      process.env.WIN_STORE_PACKER_SERVER_AZURE_SAS_URL ??
      process.env.SERVER_AZURE_SAS_URL ??
      process.env.SERVICE_AZURE_SAS_URL ??
      process.env.AZURE_BLOB_SAS_URL ??
      process.env.AZURE_SAS_URL,
    dlcAssetSource: values['dlc-asset-source'],
    dlcAzureSasUrl:
      values['dlc-azure-sas-url'] ??
      process.env.WIN_STORE_PACKER_DLC_AZURE_SAS_URL ??
      process.env.DLC_AZURE_SAS_URL ??
      process.env.AZURE_BLOB_SAS_URL ??
      process.env.AZURE_SAS_URL
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## Runtime payload staging failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
