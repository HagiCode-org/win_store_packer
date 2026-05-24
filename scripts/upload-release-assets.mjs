#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { getReleaseByTag, uploadReleaseAsset } from './lib/github.mjs';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

function contentTypeFromPath(filePath) {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (lowerPath.endsWith('.appx') || lowerPath.endsWith('.msix')) {
    return 'application/vnd.ms-appx';
  }
  return 'application/octet-stream';
}

function normalizeArtifactInventoryPaths(entries, artifactsDir) {
  return entries
    .filter((entry) => entry.startsWith('artifact-inventory-') && entry.endsWith('.json'))
    .map((entry) => path.join(artifactsDir, entry))
    .sort((left, right) => left.localeCompare(right));
}

async function resolveArtifactUploadPath(artifactsDir, artifact) {
  const candidates = [
    artifact.outputPath,
    path.join(artifactsDir, artifact.fileName),
    path.join(artifactsDir, 'release-assets', artifact.fileName)
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to find uploaded artifact ${artifact.fileName}. Checked: ${candidates.join(', ')}`);
}

export async function uploadReleaseAssets({
  planPath,
  artifactsDir,
  outputDir,
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  fetchImpl = globalThis.fetch
}) {
  const { plan } = await loadReleasePlan(planPath);
  const resolvedArtifactsDir = path.resolve(artifactsDir);
  const resolvedOutputDir = path.resolve(outputDir);
  await ensureDir(resolvedOutputDir);

  if (!token) {
    throw new Error('upload-release-assets requires GITHUB_TOKEN or GH_TOKEN.');
  }

  const entries = await readdir(resolvedArtifactsDir);
  const inventoryPaths = normalizeArtifactInventoryPaths(entries, resolvedArtifactsDir);
  if (inventoryPaths.length === 0) {
    throw new Error(`No artifact inventory files were found in ${resolvedArtifactsDir}.`);
  }

  const release = await getReleaseByTag(plan.release.repository, plan.release.tag, token, { fetchImpl });
  const inventories = await Promise.all(inventoryPaths.map((inventoryPath) => readJson(inventoryPath)));
  const artifacts = inventories.flatMap((inventory) => inventory.artifacts);
  const uploadedAssets = [];

  for (const artifact of artifacts) {
    const filePath = await resolveArtifactUploadPath(resolvedArtifactsDir, artifact);
    const uploadedAsset = await uploadReleaseAsset({
      release,
      repository: plan.release.repository,
      filePath,
      fileName: artifact.fileName,
      contentType: contentTypeFromPath(filePath),
      token,
      fetchImpl
    });

    uploadedAssets.push({
      name: uploadedAsset.name,
      url: uploadedAsset.browser_download_url ?? uploadedAsset.url ?? null,
      variant: artifact.variant,
      platform: artifact.platform
    });
  }

  const result = {
    releaseTag: plan.release.tag,
    releaseUrl: release.html_url ?? null,
    uploadedAssets
  };
  const outputPath = path.join(resolvedOutputDir, `${plan.release.tag}.asset-upload-result.json`);
  await writeJson(outputPath, result);

  await appendSummary([
    '## win_store_packer assets uploaded',
    `- Release tag: ${plan.release.tag}`,
    `- Uploaded assets: ${uploadedAssets.length}`
  ]);

  return {
    ...result,
    outputPath
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'artifacts-dir': { type: 'string' },
      'output-dir': { type: 'string' }
    }
  });

  if (!values.plan || !values['artifacts-dir'] || !values['output-dir']) {
    throw new Error('upload-release-assets requires --plan, --artifacts-dir, and --output-dir.');
  }

  const result = await uploadReleaseAssets({
    planPath: values.plan,
    artifactsDir: values['artifacts-dir'],
    outputDir: values['output-dir']
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## win_store_packer asset upload failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
