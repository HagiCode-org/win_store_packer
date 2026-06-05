import path from 'node:path';
import { readJson } from './fs-utils.mjs';
import { createPlatformMatrix, getPlatformConfig, normalizeGitTag } from './platforms.mjs';
import {
  CANONICAL_PACKER_TAG_VERSION_SOURCE,
  DEFAULT_PLAN_CONSUMER_WORKFLOW,
  PUBLICATION_MODES,
  RELEASE_PLAN_ASSET_NAME,
  RELEASE_PLAN_HANDOFF_SOURCE,
  WORKFLOW_ARTIFACT_HANDOFF_SOURCE,
  WIN_STORE_PACKER_HANDOFF_SCHEMA,
} from './build-plan.mjs';

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  return value;
}

function requireEnum(value, allowedValues, label) {
  const normalized = requireNonEmptyString(value, label);
  if (!allowedValues.includes(normalized)) {
    throw new Error(`${label} must be one of ${allowedValues.join(', ')}.`);
  }
  return normalized;
}

function validatePlatforms(plan) {
  const platforms = requireArray(plan.platforms, 'plan.platforms').map((platformId) =>
    requireNonEmptyString(platformId, 'plan.platforms[]')
  );

  for (const platformId of platforms) {
    getPlatformConfig(platformId);
  }

  return platforms;
}

function validateUpstreamAssets(plan, platformId, sourceType, { required = true } = {}) {
  const upstream = requireObject(plan.upstream, 'plan.upstream');
  const source = requireObject(upstream[sourceType], `plan.upstream.${sourceType}`);
  requireNonEmptyString(source.version, `plan.upstream.${sourceType}.version`);

  const assetsByPlatform = source.assetsByPlatform;
  if (!required && (assetsByPlatform === undefined || assetsByPlatform === null)) {
    return;
  }

  const normalizedAssetsByPlatform = requireObject(
    assetsByPlatform,
    `plan.upstream.${sourceType}.assetsByPlatform`
  );
  if (!required && !normalizedAssetsByPlatform[platformId]) {
    return;
  }

  const asset = requireObject(
    normalizedAssetsByPlatform[platformId],
    `plan.upstream.${sourceType}.assetsByPlatform.${platformId}`
  );
  requireNonEmptyString(asset.name, `plan.upstream.${sourceType}.assetsByPlatform.${platformId}.name`);
  if (!asset.path && !asset.directUrl) {
    throw new Error(`plan.upstream.${sourceType}.assetsByPlatform.${platformId} must define path or directUrl.`);
  }
}

export function validateReleasePlan(
  plan,
  {
    planPath = '[inline]',
    expectedReleaseTag,
    expectedPublicationMode,
    expectedHandoffSource,
  } = {}
) {
  requireObject(plan, 'release plan');
  const handoff = requireObject(plan.handoff, 'plan.handoff');
  if (handoff.schema !== WIN_STORE_PACKER_HANDOFF_SCHEMA) {
    throw new Error(`plan.handoff.schema must be ${WIN_STORE_PACKER_HANDOFF_SCHEMA}; received ${JSON.stringify(handoff.schema)} from ${planPath}.`);
  }
  const producer = requireObject(handoff.producer, 'plan.handoff.producer');
  requireNonEmptyString(producer.repository, 'plan.handoff.producer.repository');
  requireNonEmptyString(producer.workflow, 'plan.handoff.producer.workflow');
  const consumer = requireObject(handoff.consumer, 'plan.handoff.consumer');
  requireNonEmptyString(consumer.repository, 'plan.handoff.consumer.repository');
  const consumerWorkflow = requireNonEmptyString(consumer.workflow, 'plan.handoff.consumer.workflow');
  const handoffAssetName = requireNonEmptyString(handoff.assetName, 'plan.handoff.assetName');
  const handoffSource = requireNonEmptyString(handoff.source, 'plan.handoff.source');

  if (handoffAssetName !== RELEASE_PLAN_ASSET_NAME) {
    throw new Error(`plan.handoff.assetName must be ${RELEASE_PLAN_ASSET_NAME}.`);
  }
  requireEnum(
    handoffSource,
    [RELEASE_PLAN_HANDOFF_SOURCE, WORKFLOW_ARTIFACT_HANDOFF_SOURCE],
    'plan.handoff.source'
  );
  if (consumerWorkflow !== DEFAULT_PLAN_CONSUMER_WORKFLOW) {
    throw new Error(`plan.handoff.consumer.workflow must be ${DEFAULT_PLAN_CONSUMER_WORKFLOW}.`);
  }

  const release = requireObject(plan.release, 'plan.release');
  const releaseTag = requireNonEmptyString(release.tag, 'plan.release.tag');
  requireNonEmptyString(release.repository, 'plan.release.repository');
  const canonicalVersionInput = requireNonEmptyString(release.canonicalVersionInput, 'plan.release.canonicalVersionInput');
  const windowsStoreVersion = requireNonEmptyString(release.windowsStoreVersion, 'plan.release.windowsStoreVersion');
  const versionSource = requireEnum(
    release.versionSource,
    [CANONICAL_PACKER_TAG_VERSION_SOURCE],
    'plan.release.versionSource'
  );

  if (windowsStoreVersion !== canonicalVersionInput) {
    throw new Error('plan.release.windowsStoreVersion must match plan.release.canonicalVersionInput.');
  }
  if (expectedReleaseTag && normalizeGitTag(releaseTag) !== normalizeGitTag(expectedReleaseTag)) {
    throw new Error(
      `plan.release.tag must match the expected release tag ${normalizeGitTag(expectedReleaseTag)}; received ${JSON.stringify(releaseTag)} from ${planPath}.`
    );
  }

  const upstream = requireObject(plan.upstream, 'plan.upstream');
  const desktop = requireObject(upstream.desktop, 'plan.upstream.desktop');
  const desktopSourceMode = requireNonEmptyString(desktop.sourceMode, 'plan.upstream.desktop.sourceMode');
  const desktopTag = requireNonEmptyString(desktop.tag, 'plan.upstream.desktop.tag');
  requireNonEmptyString(desktop.version, 'plan.upstream.desktop.version');
  requireNonEmptyString(desktop.baseVersion, 'plan.upstream.desktop.baseVersion');
  requireNonEmptyString(desktop.baseTag, 'plan.upstream.desktop.baseTag');
  requireNonEmptyString(desktop.checkoutRef, 'plan.upstream.desktop.checkoutRef');
  const desktopCheckoutType = requireNonEmptyString(desktop.checkoutType, 'plan.upstream.desktop.checkoutType');

  if (desktopSourceMode !== 'main') {
    throw new Error('plan.upstream.desktop.sourceMode must be main.');
  }
  if (desktopCheckoutType !== 'branch') {
    throw new Error('plan.upstream.desktop.checkoutType must be branch for main-mode packaging.');
  }
  if (desktop.checkoutRef !== 'main') {
    throw new Error('plan.upstream.desktop.checkoutRef must be main for main-mode packaging.');
  }
  if (normalizeGitTag(desktopTag) === normalizeGitTag(desktop.baseTag)) {
    throw new Error('plan.upstream.desktop.tag must differ from plan.upstream.desktop.baseTag because the main-mode package version must advance beyond the latest published Desktop release.');
  }

  const build = requireObject(plan.build, 'plan.build');
  requireBoolean(build.shouldBuild, 'plan.build.shouldBuild');
  requireBoolean(build.forceRebuild, 'plan.build.forceRebuild');
  requireBoolean(build.dryRun, 'plan.build.dryRun');

  const downloads = requireObject(plan.downloads, 'plan.downloads');
  requireObject(downloads.desktop, 'plan.downloads.desktop');
  requireObject(downloads.server, 'plan.downloads.server');

  const publication = requireObject(plan.publication ?? { mode: 'github-release' }, 'plan.publication');
  const publicationMode = requireEnum(
    publication.mode,
    [PUBLICATION_MODES.GITHUB_RELEASE, PUBLICATION_MODES.WORKFLOW_ARTIFACT],
    'plan.publication.mode'
  );

  if (publicationMode === PUBLICATION_MODES.GITHUB_RELEASE && handoffSource !== RELEASE_PLAN_HANDOFF_SOURCE) {
    throw new Error(`plan.handoff.source must be ${RELEASE_PLAN_HANDOFF_SOURCE} when plan.publication.mode is ${PUBLICATION_MODES.GITHUB_RELEASE}.`);
  }
  if (publicationMode === PUBLICATION_MODES.WORKFLOW_ARTIFACT && handoffSource !== WORKFLOW_ARTIFACT_HANDOFF_SOURCE) {
    throw new Error(`plan.handoff.source must be ${WORKFLOW_ARTIFACT_HANDOFF_SOURCE} when plan.publication.mode is ${PUBLICATION_MODES.WORKFLOW_ARTIFACT}.`);
  }
  if (expectedPublicationMode && publicationMode !== expectedPublicationMode) {
    throw new Error(`plan.publication.mode must be ${expectedPublicationMode}; received ${JSON.stringify(publicationMode)} from ${planPath}.`);
  }
  if (expectedHandoffSource && handoffSource !== expectedHandoffSource) {
    throw new Error(`plan.handoff.source must be ${expectedHandoffSource}; received ${JSON.stringify(handoffSource)} from ${planPath}.`);
  }

  const store = requireObject(plan.store, 'plan.store');
  requireArray(store.supportedWindowsTargets, 'plan.store.supportedWindowsTargets');
  const desktopStore = requireObject(store.desktop, 'plan.store.desktop');
  requireNonEmptyString(desktopStore.storeConfigPath, 'plan.store.desktop.storeConfigPath');
  requireNonEmptyString(desktopStore.buildCommand, 'plan.store.desktop.buildCommand');
  requireNonEmptyString(desktopStore.runtimeInjectionPath, 'plan.store.desktop.runtimeInjectionPath');

  const platforms = validatePlatforms(plan);
  for (const platformId of platforms) {
    validateUpstreamAssets(plan, platformId, 'desktop', { required: false });
    validateUpstreamAssets(plan, platformId, 'server');
  }

  return {
    plan: {
      ...plan,
      platformMatrix: plan.platformMatrix?.include?.length ? plan.platformMatrix : createPlatformMatrix(platforms)
    },
    planPath,
    releaseTag: release.tag,
    canonicalVersionInput,
    windowsStoreVersion,
    versionSource,
    expectedReleaseTag: expectedReleaseTag ? normalizeGitTag(expectedReleaseTag) : null,
    dryRun: build.dryRun,
    shouldBuild: build.shouldBuild,
    forceRebuild: build.forceRebuild,
    publicationMode,
    handoffAssetName,
    handoffSource,
    platforms
  };
}

export async function loadReleasePlan(planPath, options = {}) {
  const resolvedPlanPath = path.resolve(planPath);
  return validateReleasePlan(await readJson(resolvedPlanPath), { ...options, planPath: resolvedPlanPath });
}
