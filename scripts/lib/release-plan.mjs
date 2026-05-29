import path from 'node:path';
import { readJson } from './fs-utils.mjs';
import { createPlatformMatrix, getPlatformConfig } from './platforms.mjs';
import { WIN_STORE_PACKER_HANDOFF_SCHEMA } from './build-plan.mjs';

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

export function validateReleasePlan(plan, { planPath = '[inline]' } = {}) {
  requireObject(plan, 'release plan');
  const handoff = requireObject(plan.handoff, 'plan.handoff');
  if (handoff.schema !== WIN_STORE_PACKER_HANDOFF_SCHEMA) {
    throw new Error(`plan.handoff.schema must be ${WIN_STORE_PACKER_HANDOFF_SCHEMA}; received ${JSON.stringify(handoff.schema)} from ${planPath}.`);
  }

  const release = requireObject(plan.release, 'plan.release');
  requireNonEmptyString(release.tag, 'plan.release.tag');
  requireNonEmptyString(release.repository, 'plan.release.repository');

  const build = requireObject(plan.build, 'plan.build');
  requireBoolean(build.shouldBuild, 'plan.build.shouldBuild');
  requireBoolean(build.forceRebuild, 'plan.build.forceRebuild');
  requireBoolean(build.dryRun, 'plan.build.dryRun');

  const downloads = requireObject(plan.downloads, 'plan.downloads');
  requireObject(downloads.desktop, 'plan.downloads.desktop');
  requireObject(downloads.server, 'plan.downloads.server');

  const publication = requireObject(plan.publication ?? { mode: 'github-release' }, 'plan.publication');
  const publicationMode = requireEnum(publication.mode, ['github-release', 'workflow-artifact'], 'plan.publication.mode');

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
    dryRun: build.dryRun,
    shouldBuild: build.shouldBuild,
    forceRebuild: build.forceRebuild,
    publicationMode,
    platforms
  };
}

export async function loadReleasePlan(planPath) {
  const resolvedPlanPath = path.resolve(planPath);
  return validateReleasePlan(await readJson(resolvedPlanPath), { planPath: resolvedPlanPath });
}
