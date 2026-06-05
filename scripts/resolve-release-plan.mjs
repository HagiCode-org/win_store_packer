#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { WIN_STORE_PACKER_HANDOFF_SCHEMA } from './lib/build-plan.mjs';

async function writeGithubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'expected-release-tag': { type: 'string' }
    },
    strict: true
  });

  if (!values.plan) {
    throw new Error('resolve-release-plan requires --plan.');
  }

  const releasePlan = await loadReleasePlan(values.plan, {
    expectedReleaseTag: values['expected-release-tag']
  });
  await writeGithubOutputs({
    release_tag: releasePlan.releaseTag,
    canonical_version_input: releasePlan.canonicalVersionInput,
    windows_store_version: releasePlan.windowsStoreVersion,
    dry_run: releasePlan.dryRun,
    should_build: releasePlan.shouldBuild,
    platform_matrix: JSON.stringify(releasePlan.plan.platformMatrix),
    publication_mode: releasePlan.publicationMode,
    handoff_schema: WIN_STORE_PACKER_HANDOFF_SCHEMA,
    handoff_asset_name: releasePlan.handoffAssetName,
    desktop_checkout_ref: releasePlan.plan.upstream.desktop.checkoutRef,
    desktop_version: releasePlan.plan.upstream.desktop.version,
    server_version: releasePlan.plan.upstream.server.version
  });

  await appendSummary([
    '## win_store_packer release plan accepted',
    `- Release tag: ${releasePlan.releaseTag}`,
    `- Canonical version input: ${releasePlan.canonicalVersionInput}`,
    `- Windows Store version: ${releasePlan.windowsStoreVersion}`,
    `- Version source: ${releasePlan.versionSource}`,
    `- Plan: ${path.resolve(values.plan)}`,
    `- Release plan asset: ${releasePlan.handoffAssetName}`,
    `- Desktop checkout ref: ${releasePlan.plan.upstream.desktop.checkoutRef}`,
    `- Desktop version: ${releasePlan.plan.upstream.desktop.version}`,
    `- Server version: ${releasePlan.plan.upstream.server.version}`,
    `- Expected release tag: ${releasePlan.expectedReleaseTag ?? '[none]'}`,
    `- Dry run: ${releasePlan.dryRun ? 'true' : 'false'}`,
    `- Platforms: ${releasePlan.platforms.join(', ')}`
  ]);

  console.log(
    JSON.stringify(
      {
        releaseTag: releasePlan.releaseTag,
        canonicalVersionInput: releasePlan.canonicalVersionInput,
        windowsStoreVersion: releasePlan.windowsStoreVersion,
        versionSource: releasePlan.versionSource,
        dryRun: releasePlan.dryRun,
        shouldBuild: releasePlan.shouldBuild,
        platformMatrix: releasePlan.plan.platformMatrix,
        publicationMode: releasePlan.publicationMode,
        handoffSchema: WIN_STORE_PACKER_HANDOFF_SCHEMA,
        handoffAssetName: releasePlan.handoffAssetName,
        desktopCheckoutRef: releasePlan.plan.upstream.desktop.checkoutRef,
        desktopVersion: releasePlan.plan.upstream.desktop.version,
        serverVersion: releasePlan.plan.upstream.server.version,
        expectedReleaseTag: releasePlan.expectedReleaseTag
      },
      null,
      2
    )
  );
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## win_store_packer release plan failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
