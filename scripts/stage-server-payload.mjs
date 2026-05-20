#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanDir, copyDir, ensureDir, readJson, writeJson } from './lib/fs-utils.mjs';
import { resolveAssetDownloadUrl, downloadFromSource, sanitizeUrlForLogs } from './lib/azure-blob.mjs';
import { extractArchive } from './lib/archive.mjs';
import { resolveRuntimeRoot, validateServerPayloadRoot } from './lib/payload.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

export async function stageServerPayload({
  planPath,
  workspacePath,
  platformId,
  serverAssetSource,
  azureSasUrl
}) {
  const { plan } = await loadReleasePlan(planPath);
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const workspaceManifest = await readJson(path.join(resolvedWorkspacePath, 'workspace-manifest.json'));
  const asset = plan.upstream.server.assetsByPlatform?.[platformId];
  if (!asset) {
    throw new Error(`No server asset mapped for platform ${platformId}.`);
  }

  const downloadPath = path.join(workspaceManifest.downloadDirectory, `${platformId}-${asset.name}`);
  const extractionPath = path.join(workspaceManifest.extractDirectory, 'server');
  const targetPath = workspaceManifest.runtimeInjectionRoot;
  await ensureDir(workspaceManifest.downloadDirectory);
  await cleanDir(extractionPath);
  await cleanDir(targetPath);

  const assetSource = resolveAssetDownloadUrl({
    asset,
    sasUrl: azureSasUrl,
    overrideSource: serverAssetSource
  });
  await downloadFromSource({ sourceUrl: assetSource, destinationPath: downloadPath });
  await extractArchive(downloadPath, extractionPath);

  const runtimeRoot = await resolveRuntimeRoot(extractionPath);
  if (!runtimeRoot) {
    throw new Error(`Unable to find an extracted server runtime under ${extractionPath}.`);
  }

  const validation = await validateServerPayloadRoot(runtimeRoot, platformId);
  await copyDir(runtimeRoot, targetPath);

  const validationReport = {
    validationPassed: true,
    platform: platformId,
    desktopVersion: workspaceManifest.desktopVersion,
    desktopTag: workspaceManifest.desktopTag,
    desktopRef: workspaceManifest.desktopRef,
    serverVersion: workspaceManifest.serverVersion,
    assetName: asset.name,
    assetPath: asset.path ?? null,
    downloadSource: sanitizeUrlForLogs(assetSource),
    downloadPath,
    extractionPath,
    validatedPayloadRoot: validation.runtimeRoot,
    embeddedTargetRoot: targetPath,
    requiredPaths: validation.requiredPaths
  };
  const validationReportPath = path.join(resolvedWorkspacePath, `payload-validation-${platformId}.json`);
  await writeJson(validationReportPath, validationReport);

  await appendSummary([
    `### Server payload staged for ${platformId}`,
    `- Server version: ${workspaceManifest.serverVersion}`,
    `- Desktop tag: ${workspaceManifest.desktopTag}`,
    `- Download source: ${sanitizeUrlForLogs(assetSource)}`,
    `- Target path: ${targetPath}`
  ]);

  return {
    validationReportPath,
    stagedCurrentPath: targetPath
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'azure-sas-url': { type: 'string' },
      'server-asset-source': { type: 'string' }
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
      process.env.AZURE_SAS_URL
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## Server payload staging failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
