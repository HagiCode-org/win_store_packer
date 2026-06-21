#!/usr/bin/env node
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseAzureSasUrl, sanitizeUrlForLogs } from './lib/azure-blob.mjs';
import {
  buildPlan,
  CANONICAL_PACKER_TAG_VERSION_SOURCE,
  PUBLICATION_MODES,
  RELEASE_PLAN_ASSET_NAME,
  RELEASE_PLAN_HANDOFF_SOURCE,
} from './lib/build-plan.mjs';
import {
  resolveCanonicalVersionInput,
  resolveWindowsStoreVersion
} from './lib/release-plan.mjs';
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
  dlcAzureSasUrl,
  packerReleaseTag,
  serverAzureSasUrl,
  publicationMode = PUBLICATION_MODES.GITHUB_RELEASE,
  handoffSource = RELEASE_PLAN_HANDOFF_SOURCE,
  forceDryRun = false,
  producerWorkflow,
  findStoreRelease,
  fetchImpl
} = {}) {
  if (!desktopAzureSasUrl || !serverAzureSasUrl || !dlcAzureSasUrl) {
    throw new Error(
      'resolve-dispatch-build-plan requires Desktop, Server, and DLC Azure SAS URLs via --desktop-azure-sas-url/--server-azure-sas-url/--dlc-azure-sas-url or WIN_STORE_PACKER_DESKTOP_AZURE_SAS_URL/WIN_STORE_PACKER_SERVER_AZURE_SAS_URL/WIN_STORE_PACKER_DLC_AZURE_SAS_URL.'
    );
  }

  parseAzureSasUrl(desktopAzureSasUrl);
  parseAzureSasUrl(serverAzureSasUrl);
  parseAzureSasUrl(dlcAzureSasUrl);

  const workflowDefaults = await loadWorkflowDefaults();
  const resolvedOutputPath = path.resolve(outputPath ?? 'build/release-plan.json');
  await ensureDir(path.dirname(resolvedOutputPath));
  const resolvedEventPayload = {
    ...eventPayload,
    inputs: {
      ...(eventPayload?.inputs ?? {}),
      ...(packerReleaseTag ? { packer_release_tag: packerReleaseTag } : {}),
      ...(forceDryRun ? { dry_run: true } : {}),
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
      server: serverAzureSasUrl,
      dlc: dlcAzureSasUrl
    },
    publicationMode,
    handoffSource,
    producerWorkflow,
    findStoreRelease,
    fetchImpl
  });

  await writeJson(resolvedOutputPath, plan);
  // The canonical Microsoft Store version is always derived from the release
  // tag. The producer plan intentionally does not store it. The dispatch
  // builder knows the authoritative packer tag directly from its input, so use
  // it here instead of the omitted producer field.
  const releaseTag = packerReleaseTag ?? plan.release.tag;
  const canonicalVersionInput = resolveCanonicalVersionInput({ releaseTag });
  const windowsStoreVersion = resolveWindowsStoreVersion({ releaseTag, canonicalVersionInput });

  await writeGithubOutputs({
    plan_path: resolvedOutputPath,
    release_tag: releaseTag,
    canonical_version_input: canonicalVersionInput,
    windows_store_version: windowsStoreVersion,
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
    `- Canonical version input: ${canonicalVersionInput}`,
    `- Windows Store version: ${windowsStoreVersion}`,
    `- Version source: ${CANONICAL_PACKER_TAG_VERSION_SOURCE}`,
    `- Server manifest source: ${plan.upstream.server.manifestUrl}`,
    `- Server version: ${plan.upstream.server.version}`,
    `- Turbo Engine DLC version: ${plan.upstream.dlcs['turbo-engine']?.version ?? '[missing]'}`,
    `- Platforms: ${plan.platforms.join(', ')}`,
    `- Derived release tag: ${releaseTag}`,
    `- Release plan asset: ${plan.handoff.assetName ?? RELEASE_PLAN_ASSET_NAME}`,
    `- Handoff source: ${plan.handoff.source}`,
    `- Producer workflow: ${plan.handoff.producer.workflow}`,
    `- Publication mode: ${plan.publication.mode}`,
    `- Desktop Azure SAS: ${sanitizeUrlForLogs(desktopAzureSasUrl)}`,
    `- Server Azure SAS: ${sanitizeUrlForLogs(serverAzureSasUrl)}`,
    `- DLC Azure SAS: ${sanitizeUrlForLogs(dlcAzureSasUrl)}`,
    `- Release exists: ${plan.release.exists ? 'yes' : 'no'}`,
    `- Build mode: ${plan.build.dryRun ? 'dry-run' : 'publish'}`,
    `- should_build: ${plan.build.shouldBuild ? 'true' : 'false'}`,
    `- Skip reason: ${plan.build.skipReason ?? '[none]'}`
  ]);

  return {
    outputPath: resolvedOutputPath,
    plan,
    releaseTag,
    canonicalVersionInput,
    windowsStoreVersion
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
      'dlc-index-url': { type: 'string' },
      'desktop-azure-sas-url': { type: 'string' },
      'server-azure-sas-url': { type: 'string' },
      'dlc-azure-sas-url': { type: 'string' },
      'packer-release-tag': { type: 'string' },
      'producer-workflow': { type: 'string' },
      'publication-mode': { type: 'string' },
      'handoff-source': { type: 'string' },
      'force-dry-run': { type: 'boolean' }
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
  const dlcAzureSasUrl =
    values['dlc-azure-sas-url'] ??
    process.env.WIN_STORE_PACKER_DLC_AZURE_SAS_URL ??
    process.env.DLC_AZURE_SAS_URL ??
    process.env.PORTABLE_VERSION_DLC_AZURE_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;
  const repositories = {
    ...(values['desktop-index-url'] ?? process.env.DESKTOP_INDEX_URL
      ? { desktop: values['desktop-index-url'] ?? process.env.DESKTOP_INDEX_URL }
      : {}),
    ...(values['server-index-url'] ?? process.env.SERVER_INDEX_URL ?? process.env.SERVICE_INDEX_URL
      ? { server: values['server-index-url'] ?? process.env.SERVER_INDEX_URL ?? process.env.SERVICE_INDEX_URL }
      : {}),
    ...(values['dlc-index-url'] ?? process.env.DLC_INDEX_URL
      ? { dlc: values['dlc-index-url'] ?? process.env.DLC_INDEX_URL }
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
    publicationMode: values['publication-mode'] ?? process.env.WIN_STORE_PACKER_PUBLICATION_MODE ?? PUBLICATION_MODES.GITHUB_RELEASE,
    handoffSource: values['handoff-source'] ?? process.env.WIN_STORE_PACKER_HANDOFF_SOURCE ?? RELEASE_PLAN_HANDOFF_SOURCE,
    forceDryRun: values['force-dry-run'] ?? false,
    producerWorkflow: values['producer-workflow'] ?? process.env.WIN_STORE_PACKER_PLAN_PRODUCER_WORKFLOW,
    repositories,
    desktopAzureSasUrl,
    serverAzureSasUrl,
    dlcAzureSasUrl
  });

  console.log(
    JSON.stringify(
      {
        outputPath: result.outputPath,
        releaseTag: result.releaseTag,
        canonicalVersionInput: result.canonicalVersionInput,
        windowsStoreVersion: result.windowsStoreVersion,
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
