#!/usr/bin/env node
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseAzureSasUrl, sanitizeUrlForLogs } from './lib/azure-blob.mjs';
import {
  DEFAULT_PLAN_PRODUCER_WORKFLOW,
  RELEASE_PLAN_ASSET_NAME,
  buildPlan
} from './lib/build-plan.mjs';
import { ensureDir, readJson, writeJson } from './lib/fs-utils.mjs';
import { findActiveDraftRelease, replaceReleaseAsset } from './lib/github.mjs';
import { validateReleasePlan } from './lib/release-plan.mjs';
import { resolveDlcAzureSasUrl } from './lib/sas-config.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';
import { loadWorkflowDefaults } from './lib/store-config.mjs';

async function writeGithubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
}

export async function syncReleasePlan({
  eventName = 'schedule',
  eventPayload = {},
  outputPath,
  token,
  repositories,
  desktopAzureSasUrl,
  dlcAzureSasUrl,
  serverAzureSasUrl,
  producerWorkflow = DEFAULT_PLAN_PRODUCER_WORKFLOW,
  fetchImpl
} = {}) {
  if (!token) {
    throw new Error('sync-release-plan requires GITHUB_TOKEN or GH_TOKEN.');
  }
  const resolvedDlcAzureSasUrl = resolveDlcAzureSasUrl({ dlcAzureSasUrl, serverAzureSasUrl });

  if (!desktopAzureSasUrl || !serverAzureSasUrl || !resolvedDlcAzureSasUrl) {
    throw new Error(
      'sync-release-plan requires Desktop and Server Azure SAS URLs via --desktop-azure-sas-url/--server-azure-sas-url or WIN_STORE_PACKER_DESKTOP_AZURE_SAS_URL/WIN_STORE_PACKER_SERVER_AZURE_SAS_URL. DLC Azure SAS may be provided explicitly via --dlc-azure-sas-url or WIN_STORE_PACKER_DLC_AZURE_SAS_URL, and otherwise falls back to the Server Azure SAS URL.'
    );
  }

  parseAzureSasUrl(desktopAzureSasUrl);
  parseAzureSasUrl(serverAzureSasUrl);
  parseAzureSasUrl(resolvedDlcAzureSasUrl);

  const workflowDefaults = await loadWorkflowDefaults();
  const packerRepository = repositories?.packer ?? (process.env.GITHUB_REPOSITORY ?? 'HagiCode-org/win_store_packer');
  const draftRelease = await findActiveDraftRelease(packerRepository, token, { fetchImpl });

  if (!draftRelease) {
    await writeGithubOutputs({
      did_sync: false,
      state: 'no_draft_release',
      asset_name: RELEASE_PLAN_ASSET_NAME
    });
    await appendSummary([
      '## win_store_packer release plan sync skipped',
      '- No active draft release was available for synchronization.',
      `- Repository: ${packerRepository}`,
      `- Asset: ${RELEASE_PLAN_ASSET_NAME}`
    ]);
    return {
      state: 'no_draft_release',
      didSync: false,
      assetName: RELEASE_PLAN_ASSET_NAME
    };
  }

  const resolvedOutputPath = path.resolve(outputPath ?? 'build/release-plan.json');
  await ensureDir(path.dirname(resolvedOutputPath));
  const resolvedEventPayload = {
    ...eventPayload,
    inputs: {
      ...(eventPayload?.inputs ?? {}),
      packer_release_tag: draftRelease.tag_name
    }
  };

  const plan = await buildPlan({
    eventName,
    eventPayload: resolvedEventPayload,
    token,
    repositories: {
      ...repositories,
      packer: packerRepository
    },
    producerRepository: packerRepository,
    defaultPlatforms: workflowDefaults.defaultPlatforms,
    azureSasUrls: {
      desktop: desktopAzureSasUrl,
      server: serverAzureSasUrl,
      dlc: resolvedDlcAzureSasUrl
    },
    producerWorkflow,
    fetchImpl
  });

  validateReleasePlan(plan, {
    expectedReleaseTag: draftRelease.tag_name
  });
  await writeJson(resolvedOutputPath, plan);

  const replacement = await replaceReleaseAsset({
    release: draftRelease,
    repository: packerRepository,
    filePath: resolvedOutputPath,
    fileName: RELEASE_PLAN_ASSET_NAME,
    contentType: 'application/json; charset=utf-8',
    token,
    fetchImpl
  });

  await writeGithubOutputs({
    did_sync: true,
    state: 'synced',
    release_tag: plan.release.tag,
    draft_release_id: draftRelease.id,
    asset_name: RELEASE_PLAN_ASSET_NAME,
    asset_action: replacement.action,
    plan_path: resolvedOutputPath
  });

  await appendSummary([
    '## win_store_packer release plan synced',
    `- Draft release tag: ${plan.release.tag}`,
    `- Draft release URL: ${draftRelease.html_url ?? '[unavailable]'}`,
    `- Asset: ${RELEASE_PLAN_ASSET_NAME}`,
    `- Asset action: ${replacement.action}`,
    `- Desktop version: ${plan.upstream.desktop.version}`,
    `- Desktop base version: ${plan.upstream.desktop.baseVersion}`,
    `- Desktop checkout ref: ${plan.upstream.desktop.checkoutRef}`,
    `- Server version: ${plan.upstream.server.version}`,
    `- Turbo Engine DLC version: ${plan.upstream.dlcs['turbo-engine']?.version ?? '[missing]'}`,
    `- Desktop Azure SAS: ${sanitizeUrlForLogs(desktopAzureSasUrl)}`,
    `- Server Azure SAS: ${sanitizeUrlForLogs(serverAzureSasUrl)}`,
    `- DLC Azure SAS: ${sanitizeUrlForLogs(resolvedDlcAzureSasUrl)}`,
    `- Plan: ${resolvedOutputPath}`
  ]);

  return {
    state: 'synced',
    didSync: true,
    outputPath: resolvedOutputPath,
    assetAction: replacement.action,
    asset: replacement.asset,
    draftRelease,
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
      'dlc-index-url': { type: 'string' },
      'desktop-azure-sas-url': { type: 'string' },
      'server-azure-sas-url': { type: 'string' },
      'dlc-azure-sas-url': { type: 'string' },
      'producer-workflow': { type: 'string' }
    }
  });

  const eventName = values['event-name'] ?? process.env.GITHUB_EVENT_NAME ?? 'schedule';
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
  const dlcAzureSasUrl = resolveDlcAzureSasUrl({
    dlcAzureSasUrl:
      values['dlc-azure-sas-url'] ??
      process.env.WIN_STORE_PACKER_DLC_AZURE_SAS_URL ??
      process.env.DLC_AZURE_SAS_URL ??
      process.env.PORTABLE_VERSION_DLC_AZURE_SAS_URL ??
      process.env.AZURE_BLOB_SAS_URL ??
      process.env.AZURE_SAS_URL,
    serverAzureSasUrl
  });
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

  const result = await syncReleasePlan({
    eventName,
    eventPayload,
    outputPath: values.output,
    token,
    repositories,
    desktopAzureSasUrl,
    dlcAzureSasUrl,
    serverAzureSasUrl,
    producerWorkflow: values['producer-workflow'] ?? process.env.WIN_STORE_PACKER_PLAN_PRODUCER_WORKFLOW,
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## win_store_packer release plan sync failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
