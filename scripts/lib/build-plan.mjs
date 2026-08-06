import {
  buildSignedBlobUrl,
  composePublicAssetUrl,
  DEFAULT_DLC_PUBLIC_BASE_URL,
  DEFAULT_SERVER_PUBLIC_BASE_URL,
  getAzureBlobContainerUrl,
  sanitizeUrlForLogs
} from './artifact-download.mjs';
import { findReleaseByTag } from './github.mjs';
import {
  DEFAULT_INDEX_MANIFEST_PATH,
  DEFAULT_INDEX_SOURCES,
  resolveDlcIndexRelease,
  resolveIndexRelease
} from './index-source.mjs';
import {
  createPlatformMatrix,
  DEFAULT_PLATFORMS,
  getPlatformConfig,
  normalizeGitTag,
  normalizePlatforms
} from './platforms.mjs';
import { loadStorePackageConfig } from './store-config.mjs';

export const WIN_STORE_PACKER_HANDOFF_SCHEMA = 'win-store-packer-handoff/v1';
export const CANONICAL_PACKER_TAG_VERSION_SOURCE = 'release-drafter-packer-tag';
// Fixed version reported by non-tagged main test builds. The canonical
// Microsoft Store version is always derived from the release tag; builds that
// are not bound to a tag report this fixed sentinel version instead.
export const DESKTOP_MAIN_BUILD_VERSION = '0.1.0';
export const RELEASE_PLAN_ASSET_NAME = 'release-plan.json';
export const RELEASE_PLAN_HANDOFF_SOURCE = 'draft-release-asset';
export const WORKFLOW_ARTIFACT_HANDOFF_SOURCE = 'workflow-artifact';
export const DEFAULT_PLAN_PRODUCER_WORKFLOW = 'package-release';
export const DEFAULT_PLAN_CONSUMER_WORKFLOW = 'package-release';
export const DESKTOP_SOURCE_MODES = {
  MAIN: 'main'
};

export const PUBLICATION_MODES = {
  GITHUB_RELEASE: 'github-release',
  WORKFLOW_ARTIFACT: 'workflow-artifact'
};

const DEFAULT_REPOSITORIES = {
  packer: 'HagiCode-org/win_store_packer'
};

function normalizeBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function coalesce(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function normalizePackerReleaseTag(value) {
  return normalizeGitTag(value);
}

function normalizeDesktopSourceMode(value, defaultValue = DESKTOP_SOURCE_MODES.MAIN) {
  const normalized = String(value ?? defaultValue).trim().toLowerCase();
  if (normalized === DESKTOP_SOURCE_MODES.MAIN) {
    return normalized;
  }

  throw new Error(
    `Unsupported desktop_source ${JSON.stringify(value)}. Only desktop_source=main is supported because release-mode packaging has been removed.`
  );
}

function resolveIndexRepository({ sourceType, explicitUrl, azureSasUrl }) {
  if (explicitUrl) {
    return {
      requestUrl: explicitUrl,
      manifestUrl: sanitizeUrlForLogs(explicitUrl),
      sourceAuthority: 'explicit-override',
      manifestPath: null
    };
  }

  if (azureSasUrl) {
    const requestUrl = buildSignedBlobUrl(azureSasUrl, DEFAULT_INDEX_MANIFEST_PATH);
    return {
      requestUrl,
      manifestUrl: sanitizeUrlForLogs(requestUrl),
      sourceAuthority: 'legacy-azure-sas',
      manifestPath: DEFAULT_INDEX_MANIFEST_PATH
    };
  }

  const fallbackUrl = DEFAULT_INDEX_SOURCES[sourceType];
  return {
    requestUrl: fallbackUrl,
    manifestUrl: fallbackUrl,
    sourceAuthority: 'cloudflare-index-default',
    manifestPath: null
  };
}

function createDerivedDlcRelease({ serverRelease, dlcConfig, platforms, publicBaseUrl = DEFAULT_DLC_PUBLIC_BASE_URL }) {
  const assetsByPlatform = {};
  for (const platformId of platforms) {
    const platform = getPlatformConfig(platformId);
    const name = `hagicode-dlc-${dlcConfig.sourceName}-${serverRelease.version}-${platform.runtimeKey}.zip`;
    const assetPath = `${dlcConfig.directoryId}/${serverRelease.version}/${name}`;
    assetsByPlatform[platformId] = {
      name,
      path: assetPath,
      size: null,
      directUrl: composePublicAssetUrl(publicBaseUrl, assetPath),
      lastModified: null,
      sha256: null
    };
  }

  return {
    sourceType: 'server-version-derived',
    sourceAuthority: serverRelease.sourceAuthority,
    manifestUrl: null,
    manifestPath: null,
    selector: null,
    dlcName: dlcConfig.sourceName,
    version: serverRelease.version,
    updatedAt: serverRelease.updatedAt ?? null,
    assetsByPlatform
  };
}

export function normalizeTriggerInputs({ eventName, eventPayload, defaultPlatforms = DEFAULT_PLATFORMS }) {
  const inputs = eventPayload?.inputs ?? {};
  const clientPayload = eventPayload?.client_payload ?? {};
  const desktopSourceInput = coalesce(inputs.desktop_source, clientPayload.desktopSource, clientPayload.desktop_source);
  const desktopSelector = coalesce(inputs.desktop_version, inputs.desktop_tag, clientPayload.desktopVersion, clientPayload.desktopTag);
  if (desktopSelector !== undefined && desktopSelector !== null && String(desktopSelector).trim() !== '') {
    throw new Error(
      'Desktop release selectors are no longer supported. The packaging plan always builds from desktop main and resolves Desktop version metadata from the latest indexed Desktop release.'
    );
  }

  const desktopSourceMode = normalizeDesktopSourceMode(
    desktopSourceInput,
    DESKTOP_SOURCE_MODES.MAIN
  );
  const serverSelector = coalesce(inputs.server_version, inputs.server_tag, clientPayload.serverVersion, clientPayload.serverTag);
  const packerReleaseTag = coalesce(
    inputs.release_tag,
    inputs.packer_release_tag,
    inputs.packer_tag,
    clientPayload.releaseTag,
    clientPayload.release_tag,
    clientPayload.packerReleaseTag,
    clientPayload.packer_release_tag,
    process.env.WIN_STORE_PACKER_RELEASE_TAG,
    process.env.PACKER_RELEASE_TAG
  );
  const platforms = coalesce(inputs.platforms, clientPayload.platforms);
  const forceRebuild = normalizeBoolean(coalesce(inputs.force_rebuild, clientPayload.forceRebuild, clientPayload.force_rebuild), false);
  const dryRun = normalizeBoolean(coalesce(inputs.dry_run, clientPayload.dryRun, clientPayload.dry_run), false);

  return {
    triggerType: eventName,
    desktopSourceMode,
    desktopSelector,
    serverSelector,
    packerReleaseTag: packerReleaseTag ? normalizePackerReleaseTag(packerReleaseTag) : null,
    selectedPlatforms: normalizePlatforms(platforms, defaultPlatforms),
    forceRebuild,
    dryRun,
    rawInputs: {
      desktop_source: desktopSourceMode,
      desktop_version: null,
      server_version: serverSelector ?? null,
      packer_release_tag: packerReleaseTag ?? null,
      platforms: platforms ?? null,
      force_rebuild: forceRebuild,
      dry_run: dryRun
    }
  };
}

export async function buildPlan({
  eventName = 'workflow_dispatch',
  eventPayload = {},
  token,
  repositories = DEFAULT_REPOSITORIES,
  producerRepository = 'HagiCode-org/win_store_packer',
  defaultPlatforms = DEFAULT_PLATFORMS,
  now = new Date().toISOString(),
  fetchImpl,
  findStoreRelease = findReleaseByTag,
  azureSasUrls = {},
  publicBaseUrls = {},
  publicationMode = PUBLICATION_MODES.GITHUB_RELEASE,
  producerWorkflow = DEFAULT_PLAN_PRODUCER_WORKFLOW,
  consumerWorkflow = DEFAULT_PLAN_CONSUMER_WORKFLOW,
  handoffAssetName = RELEASE_PLAN_ASSET_NAME,
  handoffSource = RELEASE_PLAN_HANDOFF_SOURCE
} = {}) {
  const trigger = normalizeTriggerInputs({ eventName, eventPayload, defaultPlatforms });
  const storePackageConfig = await loadStorePackageConfig();

  const packerRepository = repositories?.packer ?? DEFAULT_REPOSITORIES.packer;
  const desktopRepository = resolveIndexRepository({
    sourceType: 'desktop',
    explicitUrl: repositories?.desktop,
    azureSasUrl: azureSasUrls.desktop
  });
  const serverRepository = resolveIndexRepository({
    sourceType: 'service',
    explicitUrl: repositories?.server,
    azureSasUrl: azureSasUrls.server
  });
  const hasDlcIndexSource = Boolean(repositories?.dlc || azureSasUrls.dlc);
  const dlcRepository = hasDlcIndexSource
    ? resolveIndexRepository({
        sourceType: 'dlc',
        explicitUrl: repositories?.dlc,
        azureSasUrl: azureSasUrls.dlc
      })
    : null;
  const configuredDlcs = Object.values(storePackageConfig.dlcs);

  const [desktopRelease, serverRelease, ...dlcReleases] = await Promise.all([
    resolveIndexRelease({
      sourceType: 'desktop',
      indexUrl: desktopRepository.requestUrl,
      manifestUrl: desktopRepository.manifestUrl,
      sourceAuthority: desktopRepository.sourceAuthority,
      manifestPath: desktopRepository.manifestPath,
      selector: null,
      platforms: trigger.selectedPlatforms,
      fetchImpl
    }),
    resolveIndexRelease({
      sourceType: 'service',
      indexUrl: serverRepository.requestUrl,
      manifestUrl: serverRepository.manifestUrl,
      sourceAuthority: serverRepository.sourceAuthority,
      manifestPath: serverRepository.manifestPath,
      selector: trigger.serverSelector,
      platforms: trigger.selectedPlatforms,
      fetchImpl
    }),
    ...(hasDlcIndexSource
      ? configuredDlcs.map((dlcConfig) =>
          resolveDlcIndexRelease({
            indexUrl: dlcRepository.requestUrl,
            manifestUrl: dlcRepository.manifestUrl,
            manifestPath: dlcRepository.manifestPath,
            sourceAuthority: dlcRepository.sourceAuthority,
            dlcName: dlcConfig.sourceName,
            directoryId: dlcConfig.directoryId,
            platforms: trigger.selectedPlatforms,
            fetchImpl
          })
        )
      : [])
  ]);
  const serverPublicBaseUrl = publicBaseUrls.server ?? DEFAULT_SERVER_PUBLIC_BASE_URL;
  const dlcPublicBaseUrl = publicBaseUrls.dlc ?? DEFAULT_DLC_PUBLIC_BASE_URL;
  const upstreamDlcs = Object.fromEntries(
    configuredDlcs.map((dlcConfig, index) => [
      dlcConfig.directoryId,
      {
        ...(hasDlcIndexSource
          ? dlcReleases[index]
          : createDerivedDlcRelease({
              serverRelease,
              dlcConfig,
              platforms: trigger.selectedPlatforms,
              publicBaseUrl: dlcPublicBaseUrl
            })),
        dlcId: dlcConfig.dlcId,
        directoryId: dlcConfig.directoryId,
      }
    ])
  );

  const baseDesktopTag = normalizeGitTag(desktopRelease.version);
  const desktopTag = baseDesktopTag;
  const desktopCheckoutRef = 'main';
  const desktopCheckoutType = 'branch';
  const releaseTag = trigger.packerReleaseTag;
  if (!releaseTag) {
    throw new Error('buildPlan requires a packer Release Drafter tag via trigger input or WIN_STORE_PACKER_RELEASE_TAG.');
  }
  const existingRelease = publicationMode === PUBLICATION_MODES.GITHUB_RELEASE
    ? await findStoreRelease(packerRepository, releaseTag, token, { fetchImpl })
    : null;
  const releaseExists = Boolean(existingRelease);
  const shouldBuild = true;
  const skipReason = null;

  return {
    schemaVersion: 1,
    generatedAt: now,
    repositories: {
      desktop: desktopRepository.manifestUrl,
      server: serverRepository.manifestUrl,
      dlc: dlcRepository?.manifestUrl ?? null,
      packer: packerRepository
    },
    trigger: {
      type: trigger.triggerType,
      desktopSourceMode: trigger.desktopSourceMode,
      rawInputs: trigger.rawInputs
    },
    platforms: trigger.selectedPlatforms,
    platformMatrix: createPlatformMatrix(trigger.selectedPlatforms),
    downloads: {
      strategy: 'public-r2',
      desktop: {
        containerUrl: azureSasUrls.desktop ? getAzureBlobContainerUrl(azureSasUrls.desktop) : null,
        redactedSasUrl: azureSasUrls.desktop ? sanitizeUrlForLogs(azureSasUrls.desktop) : null
      },
      server: {
        containerUrl: azureSasUrls.server ? getAzureBlobContainerUrl(azureSasUrls.server) : null,
        redactedSasUrl: azureSasUrls.server ? sanitizeUrlForLogs(azureSasUrls.server) : null,
        publicBaseUrl: serverPublicBaseUrl
      },
      dlc: {
        containerUrl: azureSasUrls.dlc ? getAzureBlobContainerUrl(azureSasUrls.dlc) : null,
        redactedSasUrl: azureSasUrls.dlc ? sanitizeUrlForLogs(azureSasUrls.dlc) : null,
        publicBaseUrl: dlcPublicBaseUrl
      }
    },
    upstream: {
      desktop: {
        ...desktopRelease,
        repository: 'HagiCode-org/desktop',
        sourceMode: trigger.desktopSourceMode,
        version: desktopTag,
        tag: desktopTag,
        baseVersion: desktopRelease.version,
        baseTag: baseDesktopTag,
        checkoutRef: desktopCheckoutRef,
        checkoutType: desktopCheckoutType,
        assetsByPlatform: {}
      },
      server: {
        ...serverRelease
      },
      dlcs: upstreamDlcs
    },
    store: {
      supportedWindowsTargets: [...storePackageConfig.supportedWindowsTargets],
      desktop: {
        storeConfigPath: storePackageConfig.desktop.storeConfigPath,
        buildCommand: storePackageConfig.desktop.buildCommand,
        runtimeInjectionPath: storePackageConfig.desktop.runtimeInjectionPath
      },
      dlcs: storePackageConfig.dlcs
    },
    publication: {
      mode: publicationMode
    },
    // The release git tag is the single source of truth for the Microsoft Store
    // version. The producer plan intentionally does NOT store a version here;
    // the canonical version is always recomputed from the release tag at
    // validate time. Storing a producer-side version caused stale-version
    // failures when the draft release tag changed between sync and publication.
    release: {
      repository: packerRepository,
      exists: releaseExists,
      url: existingRelease?.html_url ?? null
    },
    build: {
      shouldBuild,
      forceRebuild: trigger.forceRebuild,
      dryRun: trigger.dryRun,
      skipReason
    },
    handoff: {
      schema: WIN_STORE_PACKER_HANDOFF_SCHEMA,
      producer: {
        repository: producerRepository,
        workflow: producerWorkflow
      },
      consumer: {
        repository: packerRepository,
        workflow: consumerWorkflow
      },
      assetName: handoffAssetName,
      source: handoffSource
    }
  };
}
