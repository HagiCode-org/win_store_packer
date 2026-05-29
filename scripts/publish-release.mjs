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

function resolveArtifactFileNames(artifact) {
  return [...new Set([
    artifact.fileName,
    artifact.outputPath ? path.basename(artifact.outputPath) : null,
    artifact.outputPath ? path.posix.basename(artifact.outputPath) : null,
    artifact.outputPath ? path.win32.basename(artifact.outputPath) : null
  ].filter(Boolean))];
}

function scoreResolvedArtifactPath(filePath, fileNames) {
  const basename = path.basename(filePath);
  const win32Basename = path.win32.basename(filePath);
  const posixBasename = path.posix.basename(filePath);
  const normalizedPath = filePath.replaceAll('\\', '/');
  const matchesRequestedName = fileNames.some((fileName) => fileName === basename || fileName === win32Basename || fileName === posixBasename);

  if (matchesRequestedName && /(^|\/)release-assets\//.test(normalizedPath)) {
    return 0;
  }

  if (matchesRequestedName) {
    return 1;
  }

  return 2;
}

async function resolveArtifactUploadPath(artifactsDir, artifact, availableFiles = []) {
  const fileNames = resolveArtifactFileNames(artifact);
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

  const recursiveMatches = availableFiles
    .filter((entry) => fileNames.some((fileName) => fileName === path.basename(entry) || fileName === path.win32.basename(entry) || fileName === path.posix.basename(entry)))
    .sort((left, right) => {
      const scoreDifference = scoreResolvedArtifactPath(left, fileNames) - scoreResolvedArtifactPath(right, fileNames);
      if (scoreDifference !== 0) {
        return scoreDifference;
      }
      if (left.length !== right.length) {
        return left.length - right.length;
      }
      return left.localeCompare(right);
    });

  if (recursiveMatches.length > 0) {
    return recursiveMatches[0];
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
  const availableFiles = files.filter((entry) => !inventoryFiles.includes(entry));
  const storePackageVersion = inventories.map((inventory) => inventory.storePackageVersion).find(Boolean) ?? null;
  const mergedArtifacts = inventories.flatMap((inventory) => inventory.artifacts);
  const desktopUnsignedArtifact = mergedArtifacts.find((artifact) => artifact.variant === 'unsigned' && artifact.desktopProduced);
  const signedArtifact = mergedArtifacts.find((artifact) => artifact.variant === 'signed' && artifact.signed === true);
  const submissionReadyArtifact = signedArtifact
    ?? mergedArtifacts.find((artifact) => artifact.primaryForStoreSubmission === true)
    ?? desktopUnsignedArtifact
    ?? mergedArtifacts[0]
    ?? null;
  const mergedInventory = {
    releaseTag: plan.release.tag,
    dryRun: Boolean(plan.build.dryRun),
    platforms: [...new Set(inventories.map((inventory) => inventory.platform))],
    variants: inventories.map((inventory) => inventory.artifactVariant).filter(Boolean),
    storePackageVersion,
    submissionReadyVariant: submissionReadyArtifact?.variant ?? null,
    artifacts: mergedArtifacts
  };

  const releaseAssets = await Promise.all(
    mergedInventory.artifacts.map((artifact) => resolveArtifactUploadPath(artifactsDir, artifact, availableFiles))
  );

  const releaseMetadata = {
    releaseTag: plan.release.tag,
    releaseName: plan.release.name,
    storePackageVersion,
    desktop: {
      version: plan.upstream.desktop.version,
      tag: plan.upstream.desktop.tag,
      baseVersion: plan.upstream.desktop.baseVersion ?? plan.upstream.desktop.version,
      baseTag: plan.upstream.desktop.baseTag ?? plan.upstream.desktop.tag,
      checkoutRef: plan.upstream.desktop.checkoutRef ?? `refs/tags/${plan.upstream.desktop.tag}`,
      checkoutType: plan.upstream.desktop.checkoutType ?? 'git-tag',
      manifestUrl: plan.upstream.desktop.manifestUrl,
      storeConfigPath: mergedArtifacts.map((artifact) => artifact.storeConfigPath).find(Boolean) ?? plan.store.desktop.storeConfigPath,
      buildCommand: plan.store.desktop.buildCommand,
    },
    server: {
      version: plan.upstream.server.version,
      manifestUrl: plan.upstream.server.manifestUrl
    },
    publication: {
      mode: plan.publication?.mode ?? 'github-release',
      desktopUnsignedArtifact: desktopUnsignedArtifact?.fileName ?? null,
      signedArtifact: signedArtifact?.fileName ?? null,
      submissionReadyVariant: submissionReadyArtifact?.variant ?? null,
      submissionReadyArtifact: submissionReadyArtifact?.fileName ?? null,
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
    releaseAssetUploads: mergedInventory.artifacts.map((artifact, index) => ({
      filePath: releaseAssets[index],
      fileName: artifact.fileName,
      contentType: contentTypeFromPath(releaseAssets[index]),
      variant: artifact.variant ?? null,
      platform: artifact.platform ?? null,
    })),
    metadataUpload: {
      filePath: metadataPath,
      fileName: path.basename(metadataPath),
      contentType: contentTypeFromPath(metadataPath)
    }
  };
}

function buildReleaseBody({ plan, publicationArtifacts, publishedAt, githubReleaseAssets }) {
  const desktopUnsignedArtifact = publicationArtifacts.releaseMetadata.publication.desktopUnsignedArtifact;
  const signedArtifact = publicationArtifacts.releaseMetadata.publication.signedArtifact;
  const submissionReadyVariant = publicationArtifacts.releaseMetadata.publication.submissionReadyVariant;
  return [
    `## Windows Store ${plan.release.tag}`,
    '',
    `- Published at: ${publishedAt}`,
    `- Desktop version: ${plan.upstream.desktop.version}`,
    `- Desktop tag: ${plan.upstream.desktop.tag}`,
    `- Server version: ${plan.upstream.server.version}`,
    `- Store config source: ${publicationArtifacts.releaseMetadata.desktop.storeConfigPath}`,
    `- Store package version: ${publicationArtifacts.releaseMetadata.storePackageVersion ?? 'unavailable'}`,
    `- Store package assets: ${publicationArtifacts.mergedInventory.artifacts.filter((artifact) => /\.(appx|msix)$/i.test(artifact.fileName)).length}`,
    `- Desktop unsigned artifact: ${desktopUnsignedArtifact ?? 'none'}`,
    `- Post-signed artifact: ${signedArtifact ?? 'none'}`,
    `- Submission-ready variant: ${submissionReadyVariant ?? 'none'}`,
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
      desktopVersion: plan.upstream.desktop.version,
      desktopTag: plan.upstream.desktop.tag,
      serverVersion: plan.upstream.server.version,
      storePackageVersion: publicationArtifacts.releaseMetadata.storePackageVersion,
      submissionReadyVariant: publicationArtifacts.releaseMetadata.publication.submissionReadyVariant,
      desktopUnsignedArtifact: publicationArtifacts.releaseMetadata.publication.desktopUnsignedArtifact,
      signedArtifact: publicationArtifacts.releaseMetadata.publication.signedArtifact,
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
      `- Store config source: ${publicationArtifacts.releaseMetadata.desktop.storeConfigPath}`,
      `- Store package version: ${publicationArtifacts.releaseMetadata.storePackageVersion ?? 'unavailable'}`,
      `- Desktop unsigned artifact: ${publicationArtifacts.releaseMetadata.publication.desktopUnsignedArtifact ?? 'none'}`,
      `- Post-signed artifact: ${publicationArtifacts.releaseMetadata.publication.signedArtifact ?? 'none'}`,
      `- Submission-ready variant: ${publicationArtifacts.releaseMetadata.publication.submissionReadyVariant ?? 'none'}`,
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

  const uploadedReleaseAssets = [];
  for (const asset of publicationArtifacts.releaseAssetUploads) {
    const uploadedAsset = await uploadReleaseAsset({
      release: releaseResult.release,
      repository: plan.release.repository,
      filePath: asset.filePath,
      fileName: asset.fileName,
      contentType: asset.contentType,
      token,
      fetchImpl
    });

    uploadedReleaseAssets.push({
      name: uploadedAsset.name,
      url: uploadedAsset.browser_download_url ?? uploadedAsset.url ?? null,
      variant: asset.variant,
      platform: asset.platform
    });

    if (Array.isArray(releaseResult.release?.assets)) {
      releaseResult.release.assets.push(uploadedAsset);
    }
  }

  const metadataAsset = await uploadReleaseAsset({
    release: releaseResult.release,
    repository: plan.release.repository,
    filePath: publicationArtifacts.metadataUpload.filePath,
    fileName: publicationArtifacts.metadataUpload.fileName,
    contentType: publicationArtifacts.metadataUpload.contentType,
    token,
    fetchImpl
  });

  const uploadedAssets = [
    ...uploadedReleaseAssets,
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
    `- Store config source: ${publicationArtifacts.releaseMetadata.desktop.storeConfigPath}`,
    `- Store package version: ${publicationArtifacts.releaseMetadata.storePackageVersion ?? 'unavailable'}`,
    `- Desktop unsigned artifact: ${publicationArtifacts.releaseMetadata.publication.desktopUnsignedArtifact ?? 'none'}`,
    `- Post-signed artifact: ${publicationArtifacts.releaseMetadata.publication.signedArtifact ?? 'none'}`,
    `- Submission-ready variant: ${publicationArtifacts.releaseMetadata.publication.submissionReadyVariant ?? 'none'}`
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
