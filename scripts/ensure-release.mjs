#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ensureDir, writeJson } from './lib/fs-utils.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { upsertReleaseNotes } from './lib/github.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

function buildBootstrapReleaseBody(plan) {
  return [
    `## Windows Store ${plan.release.tag}`,
    '',
    '- Release bootstrap created before build artifact upload.',
    `- Desktop version: ${plan.upstream.desktop.version}`,
    `- Desktop tag: ${plan.upstream.desktop.tag}`,
    `- Server version: ${plan.upstream.server.version}`,
    '- AppX assets: pending'
  ].join('\n');
}

export async function ensureRelease({
  planPath,
  outputDir,
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  fetchImpl = globalThis.fetch
}) {
  const { plan } = await loadReleasePlan(planPath);
  const resolvedOutputDir = path.resolve(outputDir);
  await ensureDir(resolvedOutputDir);

  if (!token) {
    throw new Error('ensure-release requires GITHUB_TOKEN or GH_TOKEN.');
  }

  const releaseResult = await upsertReleaseNotes(plan.release.repository, plan.release.tag, token, {
    name: plan.release.name,
    body: buildBootstrapReleaseBody(plan),
    fetchImpl
  });

  const result = {
    releaseTag: plan.release.tag,
    releaseAction: releaseResult.action,
    releaseId: releaseResult.release?.id ?? null,
    releaseUrl: releaseResult.release?.html_url ?? null,
    uploadUrl: releaseResult.release?.upload_url ?? null
  };
  const outputPath = path.join(resolvedOutputDir, `${plan.release.tag}.release-bootstrap.json`);
  await writeJson(outputPath, result);

  await appendSummary([
    '## win_store_packer release prepared',
    `- Release tag: ${plan.release.tag}`,
    `- Release action: ${releaseResult.action}`,
    `- Release URL: ${result.releaseUrl ?? 'unavailable'}`
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
      'output-dir': { type: 'string' }
    }
  });

  if (!values.plan || !values['output-dir']) {
    throw new Error('ensure-release requires --plan and --output-dir.');
  }

  const result = await ensureRelease({
    planPath: values.plan,
    outputDir: values['output-dir']
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## win_store_packer release preparation failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
