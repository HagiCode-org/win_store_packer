#!/usr/bin/env node
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseAzureSasUrl, sanitizeUrlForLogs } from './lib/azure-blob.mjs';
import { buildPlan, RELEASE_PLAN_ASSET_NAME } from './lib/build-plan.mjs';
import { ensureDir, readJson, writeJson } from './lib/fs-utils.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';
import { loadWorkflowDefaults } from './lib/store-config.mjs';

async function writeGithubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
}

export async function resolveDispatchBuildPlan({
  eventName = 'workflow_dispatch',
  eventPayload = {},
  outputPath,
  token,
  repositories,
  desktopAzureSasUrl,
  packerReleaseTag,
  serverAzureSasUrl,
  producerWorkflow,
  findStoreRelease,
  fetchImpl
} = {}) {
  if (!desktopAzureSasUrl || !serverAzureSasUrl) {
    throw new Error(
      'resolve-dispatch-build-plan requires both Desktop and Server Azure SAS URLs via --desktop-azure-sas-url/--server-azure-sas-url or WIN_STORE_PACKER_DESKTOP_AZURE_SAS_URL/WIN_STORE_PACKER_SERVER_AZURE_SAS_URL.'
    );
  }

  parseAzureSasUrl(desktopAzureSasUrl);
  parseAzureSasUrl(serverAzureSasUrl);

  const workflowDefaults = await loadWorkflowDefaults();
  const resolvedOutputPath = path.resolve(outputPath ?? 'build/release-plan.json');
  await ensureDir(path.dirname(resolvedOutputPath));
  const resolvedEventPayload = {
    ...eventPayload,
    inputs: {
      ...(eventPayload?.inputs ?? {}),
      ...(packerReleaseTag ? { packer_release_tag: packerReleaseTag } : {}),
    }
  };

  const plan = await buildPlan({
    eventName,
    eventPayload: resolvedEventPayload,
    token,
    repositories: {
      ...repositories,
      packer: repositories?.packer ?? (process.env.GITHUB_REPOSITORY ?? 'HagiCode-org/win_store_packer')
    },
    producerRepository: process.env.GITHUB_REPOSITORY ?? 'HagiCode-org/win_store_packer',
    defaultPlatforms: workflowDefaults.defaultPlatforms,
    azureSasUrls: {
      desktop: desktopAzureSasUrl,
      server: serverAzureSasUrl
    },
    producerWorkflow,
    findStoreRelease,
    fetchImpl
  });

  await writeJson(resolvedOutputPath, plan);
  await writeGithubOutputs({
    plan_path: resolvedOutputPath,
    release_tag: plan.release.tag,
    canonical_version_input: plan.release.canonicalVersionInput,
    windows_store_version: plan.release.windowsStoreVersion,
    should_build: plan.build.shouldBuild,
    dry_run: plan.build.dryRun,
    platform_matrix: JSON.stringify(plan.platformMatrix),
    handoff_asset_name: plan.handoff.assetName
  });

  await appendSummary([
    '## win_store_packer release plan',
    `- Trigger type: ${plan.trigger.type}`,
    `- Desktop source mode: ${plan.trigger.desktopSourceMode}`,
    `- Desktop manifest source: ${plan.upstream.desktop.manifestUrl}`,
    `- Desktop version: ${plan.upstream.desktop.version}`,
    `- Desktop tag: ${plan.upstream.desktop.tag}`,
    `- Desktop checkout ref: ${plan.upstream.desktop.checkoutRef}`,
    `- Desktop base version: ${plan.upstream.desktop.baseVersion}`,
    `- Canonical version input: ${plan.release.canonicalVersionInput}`,
    `- Windows Store version: ${plan.release.windowsStoreVersion}`,
    `- Version source: ${plan.release.versionSource}`,
    `- Server manifest source: ${plan.upstream.server.manifestUrl}`,
    `- Server version: ${plan.upstream.server.version}`,
    `- Platforms: ${plan.platforms.join(', ')}`,
    `- Derived release tag: ${plan.release.tag}`,
    `- Release plan asset: ${plan.handoff.assetName ?? RELEASE_PLAN_ASSET_NAME}`,
    `- Handoff source: ${plan.handoff.source}`,
    `- Producer workflow: ${plan.handoff.producer.workflow}`,
    `- Publication mode: ${plan.publication.mode}`,
    `- Desktop Azure SAS: ${sanitizeUrlForLogs(desktopAzureSasUrl)}`,
    `- Server Azure SAS: ${sanitizeUrlForLogs(serverAzureSasUrl)}`,
    `- Release exists: ${plan.release.exists ? 'yes' : 'no'}`,
    `- Build mode: ${plan.build.dryRun ? 'dry-run' : 'publish'}`,
    `- should_build: ${plan.build.shouldBuild ? 'true' : 'false'}`,
    `- Skip reason: ${plan.build.skipReason ?? '[none]'}`
  ]);

  return {
    outputPath: resolvedOutputPath,
    plan
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      'event-name': { type: 'string' },
      'event-path': { type: 'string' },
      output: { type: 'string' },
      token: { type: 'string' },
      'desktop-index-url': { type: 'string' },
      'server-index-url': { type: 'string' },
      'desktop-azure-sas-url': { type: 'string' },
      'server-azure-sas-url': { type: 'string' },
      'packer-release-tag': { type: 'string' },
      'producer-workflow': { type: 'string' }
    }
  });

  const eventName = values['event-name'] ?? process.env.GITHUB_EVENT_NAME ?? 'workflow_dispatch';
  const eventPath = values['event-path'] ?? process.env.GITHUB_EVENT_PATH;
  const token = values.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const desktopAzureSasUrl =
    values['desktop-azure-sas-url'] ??
    process.env.WIN_STORE_PACKER_DESKTOP_AZURE_SAS_URL ??
    process.env.DESKTOP_AZURE_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;
  const serverAzureSasUrl =
    values['server-azure-sas-url'] ??
    process.env.WIN_STORE_PACKER_SERVER_AZURE_SAS_URL ??
    process.env.SERVER_AZURE_SAS_URL ??
    process.env.SERVICE_AZURE_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;
  const repositories = {
    ...(values['desktop-index-url'] ?? process.env.DESKTOP_INDEX_URL
      ? { desktop: values['desktop-index-url'] ?? process.env.DESKTOP_INDEX_URL }
      : {}),
    ...(values['server-index-url'] ?? process.env.SERVER_INDEX_URL ?? process.env.SERVICE_INDEX_URL
      ? { server: values['server-index-url'] ?? process.env.SERVER_INDEX_URL ?? process.env.SERVICE_INDEX_URL }
      : {}),
    packer: process.env.GITHUB_REPOSITORY ?? 'HagiCode-org/win_store_packer'
  };
  const eventPayload = eventPath ? await readJson(eventPath) : {};

  const result = await resolveDispatchBuildPlan({
    eventName,
    eventPayload,
    outputPath: values.output,
    token,
    packerReleaseTag: values['packer-release-tag'] ?? process.env.WIN_STORE_PACKER_RELEASE_TAG ?? process.env.PACKER_RELEASE_TAG,
    producerWorkflow: values['producer-workflow'] ?? process.env.WIN_STORE_PACKER_PLAN_PRODUCER_WORKFLOW,
    repositories,
    desktopAzureSasUrl,
    serverAzureSasUrl
  });

  console.log(
    JSON.stringify(
      {
        outputPath: result.outputPath,
        releaseTag: result.plan.release.tag,
        canonicalVersionInput: result.plan.release.canonicalVersionInput,
        windowsStoreVersion: result.plan.release.windowsStoreVersion,
        shouldBuild: result.plan.build.shouldBuild,
        desktopTag: result.plan.upstream.desktop.tag,
        desktopCheckoutRef: result.plan.upstream.desktop.checkoutRef,
        publicationMode: result.plan.publication.mode,
        handoffAssetName: result.plan.handoff.assetName
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
      '## win_store_packer release plan generation failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
