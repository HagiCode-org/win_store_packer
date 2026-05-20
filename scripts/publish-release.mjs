#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { upsertReleaseNotes, uploadReleaseAsset } from './lib/github.mjs';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

function contentTypeFromPath(filePath) {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (lowerPath.endsWith('.appx')) {
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
  const entries = await readdir(artifactsDir);
  const inventoryFiles = entries.filter((entry) => entry.startsWith('artifact-inventory-') && entry.endsWith('.json'));
  if (inventoryFiles.length === 0) {
    throw new Error(`No artifact inventory files were found in ${artifactsDir}.`);
  }

  const inventories = await Promise.all(inventoryFiles.sort().map((entry) => readJson(path.join(artifactsDir, entry))));
  const mergedInventory = {
    releaseTag: plan.release.tag,
    dryRun: Boolean(plan.build.dryRun),
    platforms: inventories.map((inventory) => inventory.platform),
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
    uploads: [
      ...releaseAssets.map((filePath, index) => ({
        filePath,
        fileName: mergedInventory.artifacts[index].fileName,
        contentType: contentTypeFromPath(filePath)
      })),
      {
        filePath: metadataPath,
        fileName: path.basename(metadataPath),
        contentType: contentTypeFromPath(metadataPath)
      }
    ]
  };
}

function buildReleaseBody({ plan, publicationArtifacts, publishedAt, githubReleaseAssets }) {
  return [
    `## Windows Store ${plan.release.tag}`,
    '',
    `- Published at: ${publishedAt}`,
    `- Desktop version: ${plan.upstream.desktop.version}`,
    `- Desktop tag: ${plan.upstream.desktop.tag}`,
    `- Server version: ${plan.upstream.server.version}`,
    '- Distribution mode: steam',
    `- AppX assets: ${publicationArtifacts.mergedInventory.artifacts.length}`,
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
      uploads: publicationArtifacts.uploads.map((upload) => ({
        fileName: upload.fileName,
        filePath: upload.filePath
      }))
    };
    const dryRunReportPath = path.join(resolvedOutputDir, `${plan.release.tag}.publish-dry-run.json`);
    await writeJson(dryRunReportPath, dryRunReport);
    await appendSummary([
      '## win_store_packer publish dry run',
      `- Release tag: ${plan.release.tag}`,
      `- Desktop tag: ${plan.upstream.desktop.tag}`,
      `- Server version: ${plan.upstream.server.version}`,
      '- Distribution mode: steam',
      `- Assets prepared: ${publicationArtifacts.uploads.length}`
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
      githubReleaseAssets: publicationArtifacts.uploads.length
    }),
    fetchImpl
  });

  const uploadedAssets = [];
  for (const upload of publicationArtifacts.uploads) {
    uploadedAssets.push(
      await uploadReleaseAsset({
        release: releaseResult.release,
        repository: plan.release.repository,
        filePath: upload.filePath,
        fileName: upload.fileName,
        contentType: upload.contentType,
        token,
        fetchImpl
      })
    );
  }

  const publicationResult = {
    dryRun: false,
    releaseTag: plan.release.tag,
    releaseAction: releaseResult.action,
    releaseUrl: releaseResult.release?.html_url ?? null,
    uploadedAssets: uploadedAssets.map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url ?? asset.url ?? null
    })),
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
