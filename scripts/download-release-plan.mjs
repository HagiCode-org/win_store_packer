#!/usr/bin/env node
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RELEASE_PLAN_ASSET_NAME } from './lib/build-plan.mjs';
import { downloadReleaseAssetByName } from './lib/github.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

async function writeGithubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
}

export async function downloadReleasePlan({
  repository = process.env.GITHUB_REPOSITORY ?? 'HagiCode-org/win_store_packer',
  releaseTag,
  outputPath,
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  fetchImpl
} = {}) {
  if (!releaseTag) {
    throw new Error('download-release-plan requires a release tag.');
  }
  if (!token) {
    throw new Error('download-release-plan requires GITHUB_TOKEN or GH_TOKEN.');
  }

  const resolvedOutputPath = path.resolve(outputPath ?? path.join('build', RELEASE_PLAN_ASSET_NAME));
  const result = await downloadReleaseAssetByName({
    repository,
    releaseTag,
    assetName: RELEASE_PLAN_ASSET_NAME,
    outputPath: resolvedOutputPath,
    token,
    fetchImpl
  });

  await writeGithubOutputs({
    plan_path: result.outputPath,
    release_tag: releaseTag,
    asset_name: RELEASE_PLAN_ASSET_NAME,
    asset_id: result.asset.id
  });

  await appendSummary([
    '## win_store_packer release plan downloaded',
    `- Release tag: ${releaseTag}`,
    `- Asset: ${RELEASE_PLAN_ASSET_NAME}`,
    `- Output path: ${result.outputPath}`
  ]);

  return result;
}

export async function main() {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      'release-tag': { type: 'string' },
      output: { type: 'string' },
      token: { type: 'string' }
    },
    strict: true
  });

  const result = await downloadReleasePlan({
    repository: values.repository,
    releaseTag: values['release-tag'],
    outputPath: values.output,
    token: values.token
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## win_store_packer release plan download failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
