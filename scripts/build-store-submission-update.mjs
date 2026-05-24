#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { readJson, writeJson } from './lib/fs-utils.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

const STORE_ARCHITECTURE_BY_PLATFORM = {
  'win-x64': 'X64',
  'win-arm64': 'ARM64',
  'win-ia32': 'X86'
};

function toStoreArchitecture(platformId) {
  const architecture = STORE_ARCHITECTURE_BY_PLATFORM[String(platformId).toLowerCase()];
  if (!architecture) {
    throw new Error(`Unsupported Store platform architecture: ${platformId}`);
  }
  return architecture;
}

function findSinglePath(entries, suffix, label) {
  const matches = entries.filter((entry) => entry.endsWith(suffix));
  if (matches.length === 0) {
    throw new Error(`Missing ${label} in release metadata directory.`);
  }
  if (matches.length > 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches.length}: ${matches.join(', ')}`);
  }
  return matches[0];
}

function buildUploadedAssetMap(publicationResult) {
  return new Map(
    publicationResult.uploadedAssets.map((asset) => [asset.name, asset.url]).filter(([, url]) => Boolean(url))
  );
}

export async function buildStoreSubmissionUpdate({
  planPath,
  releaseMetadataDir,
  outputPath
}) {
  const { plan } = await loadReleasePlan(planPath);
  const entries = (await readdir(releaseMetadataDir)).sort();
  const publicationResultPath = path.join(
    releaseMetadataDir,
    findSinglePath(entries, '.publication-result.json', 'publication result')
  );
  const releaseMetadataPath = path.join(
    releaseMetadataDir,
    findSinglePath(entries, '.release-metadata.json', 'release metadata')
  );

  const publicationResult = await readJson(publicationResultPath);
  const releaseMetadata = await readJson(releaseMetadataPath);
  const uploadedAssetUrls = buildUploadedAssetMap(publicationResult);
  const languages = [...plan.store.packageIdentity.languages];

  const packages = releaseMetadata.artifacts
    .filter((artifact) => /\.(appx|msix)$/i.test(artifact.fileName))
    .filter((artifact) => artifact.primaryForStoreSubmission === true && artifact.signed === true)
    .map((artifact) => {
      const packageUrl = uploadedAssetUrls.get(artifact.fileName);
      if (!packageUrl) {
        throw new Error(`Missing published asset URL for ${artifact.fileName}.`);
      }

      return {
        packageUrl,
        languages,
        architectures: [toStoreArchitecture(artifact.platform)]
      };
    });

  if (packages.length === 0) {
    throw new Error('No primary signed AppX package was found for Store submission.');
  }

  const updatePayload = { packages };
  if (outputPath) {
    await writeJson(outputPath, updatePayload);
  }

  await appendSummary([
    '## Microsoft Store submission payload prepared',
    `- Packages: ${packages.length}`,
    `- Languages: ${languages.join(', ')}`,
    `- Release tag: ${plan.release.tag}`,
    `- Primary signed package: ${packages[0]?.packageUrl ?? 'none'}`
  ]);

  return {
    payload: updatePayload,
    publicationResultPath,
    releaseMetadataPath,
    outputPath: outputPath ? path.resolve(outputPath) : null
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'release-metadata-dir': { type: 'string' },
      output: { type: 'string' }
    }
  });

  if (!values.plan || !values['release-metadata-dir']) {
    throw new Error('build-store-submission-update requires --plan and --release-metadata-dir.');
  }

  const result = await buildStoreSubmissionUpdate({
    planPath: values.plan,
    releaseMetadataDir: values['release-metadata-dir'],
    outputPath: values.output
  });

  console.log(JSON.stringify(result.payload, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## Microsoft Store submission payload failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
