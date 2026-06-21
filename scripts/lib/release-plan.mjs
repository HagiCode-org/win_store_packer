import path from 'node:path';
import { readJson } from './fs-utils.mjs';
import { createPlatformMatrix, getPlatformConfig, normalizeGitTag } from './platforms.mjs';
import {
  CANONICAL_PACKER_TAG_VERSION_SOURCE,
  DEFAULT_PLAN_CONSUMER_WORKFLOW,
  DESKTOP_MAIN_BUILD_VERSION,
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

// Main test builds are dispatched with the packer Release Drafter's
// next-version placeholder tag (e.g. v0.1.0). They are not real releases, so
// the canonical version is reported as the fixed DESKTOP_MAIN_BUILD_VERSION
// instead of being derived from that placeholder tag. Tagged releases compute
// the canonical version directly from the tag as the single source of truth.
export function isMainBuildTag(releaseTag) {
  return normalizeGitTag(releaseTag) === normalizeGitTag(DESKTOP_MAIN_BUILD_VERSION);
}

export function resolveCanonicalVersionInput({ releaseTag, legacyCanonicalVersionInput }) {
  if (isMainBuildTag(releaseTag)) {
    return DESKTOP_MAIN_BUILD_VERSION;
  }

  if (legacyCanonicalVersionInput) {
    return legacyCanonicalVersionInput;
  }

  return releaseTag;
}

export function resolveWindowsStoreVersion({ releaseTag, canonicalVersionInput, legacyWindowsStoreVersion }) {
  if (isMainBuildTag(releaseTag)) {
    return canonicalVersionInput;
  }

  if (legacyWindowsStoreVersion) {
    return legacyWindowsStoreVersion;
  }

  return canonicalVersionInput;
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

function validateStoreDlcs(plan) {
  const store = requireObject(plan.store, 'plan.store');
  const dlcs = requireObject(store.dlcs, 'plan.store.dlcs');
  const entries = Object.entries(dlcs);
  if (entries.length === 0) {
    throw new Error('plan.store.dlcs must define at least one DLC packaging entry.');
  }

  return entries.map(([directoryId, entry]) => {
    const label = `plan.store.dlcs.${JSON.stringify(directoryId)}`;
    const dlc = requireObject(entry, label);
    const normalizedDirectoryId = requireNonEmptyString(dlc.directoryId, `${label}.directoryId`);
    if (normalizedDirectoryId !== directoryId) {
      throw new Error(`${label}.directoryId must match the DLC key ${JSON.stringify(directoryId)}.`);
    }

    requireNonEmptyString(dlc.dlcId, `${label}.dlcId`);
    requireNonEmptyString(dlc.sourceName, `${label}.sourceName`);
    requireNonEmptyString(dlc.runtimeTargetPath, `${label}.runtimeTargetPath`);
    requireNonEmptyString(dlc.runtimeIndexPath, `${label}.runtimeIndexPath`);
    requireNonEmptyString(dlc.manifestFileName, `${label}.manifestFileName`);
    requireNonEmptyString(dlc.filesManifestFileName, `${label}.filesManifestFileName`);
    return { directoryId, ...dlc };
  });
}

function validateUpstreamDlcAssets(plan, platformId, dlcConfig) {
  const upstream = requireObject(plan.upstream, 'plan.upstream');
  const upstreamDlcs = requireObject(upstream.dlcs, 'plan.upstream.dlcs');
  const source = requireObject(upstreamDlcs[dlcConfig.directoryId], `plan.upstream.dlcs.${JSON.stringify(dlcConfig.directoryId)}`);
  requireNonEmptyString(source.version, `plan.upstream.dlcs.${JSON.stringify(dlcConfig.directoryId)}.version`);
  requireNonEmptyString(source.dlcId, `plan.upstream.dlcs.${JSON.stringify(dlcConfig.directoryId)}.dlcId`);
  requireNonEmptyString(source.directoryId, `plan.upstream.dlcs.${JSON.stringify(dlcConfig.directoryId)}.directoryId`);

  const assetsByPlatform = requireObject(
    source.assetsByPlatform,
    `plan.upstream.dlcs.${JSON.stringify(dlcConfig.directoryId)}.assetsByPlatform`
  );
  const asset = requireObject(
    assetsByPlatform[platformId],
    `plan.upstream.dlcs.${JSON.stringify(dlcConfig.directoryId)}.assetsByPlatform.${platformId}`
  );
  requireNonEmptyString(asset.name, `plan.upstream.dlcs.${JSON.stringify(dlcConfig.directoryId)}.assetsByPlatform.${platformId}.name`);
  if (!asset.path && !asset.directUrl) {
    throw new Error(`plan.upstream.dlcs.${JSON.stringify(dlcConfig.directoryId)}.assetsByPlatform.${platformId} must define path or directUrl.`);
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
  requireNonEmptyString(release.repository, 'plan.release.repository');
  // Producers no longer store a version. The canonical version is recomputed
  // from the authoritative release tag. A backwards-compatible fallback reads
  // any legacy producer-stored canonicalVersionInput / windowsStoreVersion.
  const legacyCanonicalVersionInput = typeof release.canonicalVersionInput === 'string' && release.canonicalVersionInput.trim()
    ? release.canonicalVersionInput.trim()
    : null;
  const legacyWindowsStoreVersion = typeof release.windowsStoreVersion === 'string' && release.windowsStoreVersion.trim()
    ? release.windowsStoreVersion.trim()
    : null;
  const legacyVersionSource = typeof release.versionSource === 'string' && release.versionSource.trim()
    ? requireEnum(release.versionSource, [CANONICAL_PACKER_TAG_VERSION_SOURCE], 'plan.release.versionSource')
    : null;

  // The release git tag is authoritative only from external context (the
  // release event or workflow input). Producers no longer store it because a
  // stale stored tag caused publication failures when the draft release tag
  // changed between sync and publish. Prefer the externally-provided expected
  // release tag; fall back to a previously-resolved plan.release.tag for
  // backward compatibility with plans that still carry one.
  const externalReleaseTag = expectedReleaseTag ? normalizeGitTag(expectedReleaseTag) : null;
  const storedReleaseTag =
    typeof release.tag === 'string' && release.tag.trim() ? release.tag.trim() : null;
  const releaseTag = externalReleaseTag ?? storedReleaseTag;
  if (!releaseTag) {
    throw new Error(
      `Release tag is required from external context but was not provided; pass --expected-release-tag to the release plan resolver or set plan.release.tag for ${planPath}.`
    );
  }

  // Main test builds are not tied to a release tag, so they report a fixed
  // 0.1.0 version. Tagged releases compute the canonical version directly from
  // the tag as the single source of truth.
  const canonicalVersionInput = resolveCanonicalVersionInput({ releaseTag, legacyCanonicalVersionInput });
  const windowsStoreVersion = resolveWindowsStoreVersion({ releaseTag, canonicalVersionInput, legacyWindowsStoreVersion });
  const versionSource = legacyVersionSource ?? CANONICAL_PACKER_TAG_VERSION_SOURCE;

  // Inject the authoritative tag and recomputed version back into the resolved
  // plan so downstream consumers always read a single resolved release tag and
  // canonical version regardless of what the producer stored.
  const resolvedRelease = {
    ...release,
    tag: releaseTag,
    canonicalVersionInput,
    windowsStoreVersion,
    versionSource,
    name: release.name ?? `Windows Store ${releaseTag}`,
    notesTitle: release.notesTitle ?? `Windows Store ${releaseTag}`
  };

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
  const build = requireObject(plan.build, 'plan.build');
  requireBoolean(build.shouldBuild, 'plan.build.shouldBuild');
  requireBoolean(build.forceRebuild, 'plan.build.forceRebuild');
  requireBoolean(build.dryRun, 'plan.build.dryRun');

  const downloads = requireObject(plan.downloads, 'plan.downloads');
  requireObject(downloads.desktop, 'plan.downloads.desktop');
  requireObject(downloads.server, 'plan.downloads.server');
  requireObject(downloads.dlc, 'plan.downloads.dlc');

  const publication = requireObject(plan.publication ?? { mode: 'github-release' }, 'plan.publication');
  const publicationMode = requireEnum(
    publication.mode,
    [PUBLICATION_MODES.GITHUB_RELEASE, PUBLICATION_MODES.WORKFLOW_ARTIFACT],
    'plan.publication.mode'
  );

  // The release plan is always generated from the authoritative release tag at
  // consume time. There is no pre-synced draft-release asset anymore, so both
  // publication modes use the workflow-artifact handoff. Legacy plans that
  // still carry the draft-release-asset handoff remain accepted for
  // backward compatibility.
  if (publicationMode === PUBLICATION_MODES.GITHUB_RELEASE &&
      handoffSource !== WORKFLOW_ARTIFACT_HANDOFF_SOURCE &&
      handoffSource !== RELEASE_PLAN_HANDOFF_SOURCE) {
    throw new Error(`plan.handoff.source must be ${WORKFLOW_ARTIFACT_HANDOFF_SOURCE} or ${RELEASE_PLAN_HANDOFF_SOURCE} when plan.publication.mode is ${PUBLICATION_MODES.GITHUB_RELEASE}.`);
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
  const storeDlcs = validateStoreDlcs(plan);

  const platforms = validatePlatforms(plan);
  for (const platformId of platforms) {
    validateUpstreamAssets(plan, platformId, 'desktop', { required: false });
    validateUpstreamAssets(plan, platformId, 'server');
    for (const dlcConfig of storeDlcs) {
      validateUpstreamDlcAssets(plan, platformId, dlcConfig);
    }
  }

  return {
    plan: {
      ...plan,
      release: resolvedRelease,
      platformMatrix: plan.platformMatrix?.include?.length ? plan.platformMatrix : createPlatformMatrix(platforms)
    },
    planPath,
    releaseTag: resolvedRelease.tag,
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
