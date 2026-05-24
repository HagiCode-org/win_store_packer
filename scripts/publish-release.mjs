#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { upsertReleaseNotes, uploadReleaseAsset } from './lib/github.mjs';
import { ensureDir, listFilesRecursively, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
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

async function buildPublicationArtifacts({ plan, artifactsDir, outputDir }) {
  const files = await listFilesRecursively(artifactsDir);
  const inventoryFiles = files.filter((entry) => path.basename(entry).startsWith('artifact-inventory-') && entry.endsWith('.json'));
  if (inventoryFiles.length === 0) {
    throw new Error(`No artifact inventory files were found in ${artifactsDir}.`);
  }

  const inventories = await Promise.all(inventoryFiles.sort().map((entry) => readJson(entry)));
  const storePackageVersion = inventories.map((inventory) => inventory.storePackageVersion).find(Boolean) ?? null;
  const mergedInventory = {
    releaseTag: plan.release.tag,
    dryRun: Boolean(plan.build.dryRun),
    platforms: [...new Set(inventories.map((inventory) => inventory.platform))],
    variants: inventories.map((inventory) => inventory.artifactVariant).filter(Boolean),
    storePackageVersion,
    artifacts: inventories.flatMap((inventory) => inventory.artifacts)
  };

  const releaseAssets = await Promise.all(
    mergedInventory.artifacts.map((artifact) => resolveArtifactUploadPath(artifactsDir, artifact))
  );

  const releaseMetadata = {
    releaseTag: plan.release.tag,
    releaseName: plan.release.name,
    distributionMode: 'steam',
    runtimeSource: 'portable-fixed',
    storePackageVersion,
    desktop: {
      version: plan.upstream.desktop.version,
      tag: plan.upstream.desktop.tag,
      manifestUrl: plan.upstream.desktop.manifestUrl
    },
    server: {
      version: plan.upstream.server.version,
      manifestUrl: plan.upstream.server.manifestUrl
    },
    artifacts: mergedInventory.artifacts.map((artifact, index) => ({
      ...artifact,
      uploadPath: releaseAssets[index]
    }))
  };
  const metadataPath = path.join(outputDir, `${plan.release.tag}.release-metadata.json`);
  const inventoryPath = path.join(outputDir, `${plan.release.tag}.artifact-inventory.json`);
  await writeJson(metadataPath, releaseMetadata);
  await writeJson(inventoryPath, mergedInventory);

  return {
    mergedInventory,
    releaseMetadata,
    metadataPath,
    inventoryPath,
    releaseAssets,
    metadataUpload: {
      filePath: metadataPath,
      fileName: path.basename(metadataPath),
      contentType: contentTypeFromPath(metadataPath)
    }
  };
}

async function loadPriorAssetUploads(artifactsDir) {
  const files = await listFilesRecursively(artifactsDir);
  const resultFiles = files.filter((entry) => entry.endsWith('.asset-upload-result.json')).sort();
  if (resultFiles.length === 0) {
    return [];
  }

  const results = await Promise.all(resultFiles.map((filePath) => readJson(filePath)));
  return results.flatMap((result) => result.uploadedAssets ?? []);
}

function buildReleaseBody({ plan, publicationArtifacts, publishedAt, githubReleaseAssets }) {
  const primaryArtifact = publicationArtifacts.releaseMetadata.artifacts.find((artifact) => artifact.primaryForStoreSubmission);
  const signedArtifact = publicationArtifacts.releaseMetadata.artifacts.find((artifact) => artifact.variant === 'signed');
  return [
    `## Windows Store ${plan.release.tag}`,
    '',
    `- Published at: ${publishedAt}`,
    `- Desktop version: ${plan.upstream.desktop.version}`,
    `- Desktop tag: ${plan.upstream.desktop.tag}`,
    `- Server version: ${plan.upstream.server.version}`,
    `- Store package version: ${publicationArtifacts.releaseMetadata.storePackageVersion ?? 'unavailable'}`,
    '- Distribution mode: steam',
    `- AppX assets: ${publicationArtifacts.mergedInventory.artifacts.filter((artifact) => /\.(appx|msix)$/i.test(artifact.fileName)).length}`,
    `- Primary Store submission artifact: ${primaryArtifact?.fileName ?? 'none'}`,
    `- Optional signed sideload artifact: ${signedArtifact?.fileName ?? 'none'}`,
    `- Release metadata asset: ${path.basename(publicationArtifacts.metadataPath)}`,
    `- GitHub Release assets uploaded: ${githubReleaseAssets}`
  ].join('\n');
}

export async function publishRelease({
  planPath,
  artifactsDir,
  outputDir,
  forceDryRun = false,
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  fetchImpl = globalThis.fetch
}) {
  const { plan } = await loadReleasePlan(planPath);
  const resolvedOutputDir = path.resolve(outputDir);
  const resolvedArtifactsDir = path.resolve(artifactsDir);
  await ensureDir(resolvedOutputDir);

  const publicationArtifacts = await buildPublicationArtifacts({
    plan,
    artifactsDir: resolvedArtifactsDir,
    outputDir: resolvedOutputDir
  });

  const dryRun = forceDryRun || plan.build.dryRun;
  const publishedAt = new Date().toISOString();
  if (dryRun) {
    const dryRunReport = {
      releaseTag: plan.release.tag,
      repository: plan.release.repository,
      distributionMode: 'steam',
      runtimeSource: 'portable-fixed',
      desktopVersion: plan.upstream.desktop.version,
      desktopTag: plan.upstream.desktop.tag,
      serverVersion: plan.upstream.server.version,
      storePackageVersion: publicationArtifacts.releaseMetadata.storePackageVersion,
      uploads: [
        ...publicationArtifacts.releaseAssets.map((filePath, index) => ({
          fileName: publicationArtifacts.mergedInventory.artifacts[index].fileName,
          filePath
        })),
        {
          fileName: publicationArtifacts.metadataUpload.fileName,
          filePath: publicationArtifacts.metadataUpload.filePath
        }
      ]
    };
    const dryRunReportPath = path.join(resolvedOutputDir, `${plan.release.tag}.publish-dry-run.json`);
    await writeJson(dryRunReportPath, dryRunReport);
    await appendSummary([
      '## win_store_packer publish dry run',
      `- Release tag: ${plan.release.tag}`,
      `- Desktop tag: ${plan.upstream.desktop.tag}`,
      `- Server version: ${plan.upstream.server.version}`,
      `- Store package version: ${publicationArtifacts.releaseMetadata.storePackageVersion ?? 'unavailable'}`,
      '- Distribution mode: steam',
      `- Primary Store submission package: ${publicationArtifacts.releaseMetadata.artifacts.find((artifact) => artifact.primaryForStoreSubmission)?.fileName ?? 'none'}`,
      `- Assets prepared: ${publicationArtifacts.releaseAssets.length + 1}`
    ]);

    return {
      dryRun: true,
      dryRunReportPath,
      metadataPath: publicationArtifacts.metadataPath
    };
  }

  if (!token) {
    throw new Error('publish-release requires GITHUB_TOKEN or GH_TOKEN when dry-run is disabled.');
  }

  const releaseResult = await upsertReleaseNotes(plan.release.repository, plan.release.tag, token, {
    name: plan.release.name,
    body: buildReleaseBody({
      plan,
      publicationArtifacts,
      publishedAt,
      githubReleaseAssets: publicationArtifacts.releaseAssets.length + 1
    }),
    fetchImpl
  });

  const metadataAsset = await uploadReleaseAsset({
    release: releaseResult.release,
    repository: plan.release.repository,
    filePath: publicationArtifacts.metadataUpload.filePath,
    fileName: publicationArtifacts.metadataUpload.fileName,
    contentType: publicationArtifacts.metadataUpload.contentType,
    token,
    fetchImpl
  });

  const priorAssetUploads = await loadPriorAssetUploads(resolvedArtifactsDir);
  const uploadedAssets = [
    ...priorAssetUploads,
    {
      name: metadataAsset.name,
      url: metadataAsset.browser_download_url ?? metadataAsset.url ?? null
    }
  ];

  const publicationResult = {
    dryRun: false,
    releaseTag: plan.release.tag,
    releaseAction: releaseResult.action,
    releaseUrl: releaseResult.release?.html_url ?? null,
    uploadedAssets,
    metadataPath: publicationArtifacts.metadataPath
  };
  const publicationResultPath = path.join(resolvedOutputDir, `${plan.release.tag}.publication-result.json`);
  await writeJson(publicationResultPath, publicationResult);

  await appendSummary([
    '## win_store_packer release published',
    `- Release tag: ${plan.release.tag}`,
    `- Release action: ${releaseResult.action}`,
    `- Uploaded assets: ${uploadedAssets.length}`,
    `- Desktop tag: ${plan.upstream.desktop.tag}`,
    `- Server version: ${plan.upstream.server.version}`,
    `- Store package version: ${publicationArtifacts.releaseMetadata.storePackageVersion ?? 'unavailable'}`,
    `- Primary Store submission package: ${publicationArtifacts.releaseMetadata.artifacts.find((artifact) => artifact.primaryForStoreSubmission)?.fileName ?? 'none'}`,
    '- Distribution mode: steam'
  ]);

  return publicationResult;
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'artifacts-dir': { type: 'string' },
      'output-dir': { type: 'string' },
      'force-dry-run': { type: 'boolean' }
    }
  });

  if (!values.plan || !values['artifacts-dir'] || !values['output-dir']) {
    throw new Error('publish-release requires --plan, --artifacts-dir, and --output-dir.');
  }

  const result = await publishRelease({
    planPath: values.plan,
    artifactsDir: values['artifacts-dir'],
    outputDir: values['output-dir'],
    forceDryRun: values['force-dry-run'] ?? false
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## win_store_packer publication failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
