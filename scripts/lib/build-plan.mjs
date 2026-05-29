import { buildSignedBlobUrl, getAzureBlobContainerUrl, sanitizeUrlForLogs } from './azure-blob.mjs';
import { findReleaseByTag } from './github.mjs';
import {
  DEFAULT_INDEX_MANIFEST_PATH,
  DEFAULT_INDEX_SOURCES,
  resolveIndexRelease
} from './index-source.mjs';
import {
  createPlatformMatrix,
  DEFAULT_PLATFORMS,
  deriveStoreReleaseTag,
  normalizeGitTag,
  normalizePlatforms
} from './platforms.mjs';
import { loadStorePackageConfig } from './store-config.mjs';

export const WIN_STORE_PACKER_HANDOFF_SCHEMA = 'win-store-packer-handoff/v1';
export const DESKTOP_SOURCE_MODES = {
  RELEASE: 'release',
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

function normalizeDesktopSourceMode(value, defaultValue = DESKTOP_SOURCE_MODES.RELEASE) {
  const normalized = String(value ?? defaultValue).trim().toLowerCase();
  if (Object.values(DESKTOP_SOURCE_MODES).includes(normalized)) {
    return normalized;
  }

  return defaultValue;
}

function deriveNextDesktopTag(version) {
  const normalized = normalizeGitTag(version).replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(normalized);
  if (!match) {
    throw new Error(
      `Unable to derive the next Desktop revision from ${JSON.stringify(version)}. Expected a stable version like v1.2.3.`
    );
  }

  const [, major, minor, patch] = match;
  return `v${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
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
      sourceAuthority: 'azure-blob',
      manifestPath: DEFAULT_INDEX_MANIFEST_PATH
    };
  }

  const fallbackUrl = DEFAULT_INDEX_SOURCES[sourceType];
  return {
    requestUrl: fallbackUrl,
    manifestUrl: fallbackUrl,
    sourceAuthority: 'index-site-default',
    manifestPath: null
  };
}

function createDesktopTagFallbackRelease({ selector, manifestUrl }) {
  const desktopTag = normalizeGitTag(selector);
  return {
    sourceType: 'git-tag',
    sourceAuthority: 'git-tag-fallback',
    manifestUrl,
    manifestPath: null,
    selector: desktopTag,
    version: desktopTag,
    assetsByPlatform: {}
  };
}

async function resolveDesktopRelease({
  repository,
  selector,
  platforms,
  fetchImpl
}) {
  try {
    return await resolveIndexRelease({
      sourceType: 'desktop',
      indexUrl: repository.requestUrl,
      manifestUrl: repository.manifestUrl,
      sourceAuthority: repository.sourceAuthority,
      manifestPath: repository.manifestPath,
      selector,
      platforms,
      fetchImpl
    });
  } catch (error) {
    const shouldFallbackToGitTag =
      Boolean(selector) &&
      /Unable to find Desktop version matching selector/i.test(error?.message ?? '');

    if (!shouldFallbackToGitTag) {
      throw error;
    }

    return createDesktopTagFallbackRelease({
      selector,
      manifestUrl: `https://github.com/HagiCode-org/desktop/tree/${normalizeGitTag(selector)}`
    });
  }
}

export function normalizeTriggerInputs({ eventName, eventPayload, defaultPlatforms = DEFAULT_PLATFORMS }) {
  const inputs = eventPayload?.inputs ?? {};
  const clientPayload = eventPayload?.client_payload ?? {};
  const desktopSourceMode = normalizeDesktopSourceMode(
    coalesce(inputs.desktop_source, clientPayload.desktopSource, clientPayload.desktop_source),
    eventName === 'workflow_dispatch' ? DESKTOP_SOURCE_MODES.RELEASE : DESKTOP_SOURCE_MODES.RELEASE
  );
  const desktopSelector = coalesce(inputs.desktop_version, inputs.desktop_tag, clientPayload.desktopVersion, clientPayload.desktopTag);
  const serverSelector = coalesce(inputs.server_version, inputs.server_tag, clientPayload.serverVersion, clientPayload.serverTag);
  const platforms = coalesce(inputs.platforms, clientPayload.platforms);
  const forceRebuild = normalizeBoolean(coalesce(inputs.force_rebuild, clientPayload.forceRebuild, clientPayload.force_rebuild), false);
  const dryRun = normalizeBoolean(coalesce(inputs.dry_run, clientPayload.dryRun, clientPayload.dry_run), false);

  return {
    triggerType: eventName,
    desktopSourceMode,
    desktopSelector,
    serverSelector,
    selectedPlatforms: normalizePlatforms(platforms, defaultPlatforms),
    forceRebuild,
    dryRun,
    rawInputs: {
      desktop_source: desktopSourceMode,
      desktop_version: desktopSelector ?? null,
      server_version: serverSelector ?? null,
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
  azureSasUrls = {}
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

  const [desktopRelease, serverRelease] = await Promise.all([
    resolveDesktopRelease({
      repository: desktopRepository,
      selector: trigger.desktopSourceMode === DESKTOP_SOURCE_MODES.MAIN ? null : trigger.desktopSelector,
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
    })
  ]);

  const baseDesktopTag = normalizeGitTag(desktopRelease.version);
  const desktopTag = trigger.desktopSourceMode === DESKTOP_SOURCE_MODES.MAIN
    ? deriveNextDesktopTag(baseDesktopTag)
    : baseDesktopTag;
  const desktopCheckoutRef = trigger.desktopSourceMode === DESKTOP_SOURCE_MODES.MAIN
    ? 'main'
    : `refs/tags/${desktopTag}`;
  const desktopCheckoutType = trigger.desktopSourceMode === DESKTOP_SOURCE_MODES.MAIN ? 'branch' : 'git-tag';
  const publicationMode = trigger.desktopSourceMode === DESKTOP_SOURCE_MODES.MAIN
    ? PUBLICATION_MODES.WORKFLOW_ARTIFACT
    : PUBLICATION_MODES.GITHUB_RELEASE;
  const releaseTag = deriveStoreReleaseTag(desktopTag, serverRelease.version);
  const existingRelease = publicationMode === PUBLICATION_MODES.GITHUB_RELEASE
    ? await findStoreRelease(packerRepository, releaseTag, token, { fetchImpl })
    : null;
  const releaseExists = Boolean(existingRelease);
  const shouldBuild = publicationMode === PUBLICATION_MODES.WORKFLOW_ARTIFACT
    ? true
    : !releaseExists || trigger.forceRebuild;
  const skipReason = shouldBuild
    ? null
    : `Store release ${releaseTag} already exists and force_rebuild was not enabled.`;

  return {
    schemaVersion: 1,
    generatedAt: now,
    repositories: {
      desktop: desktopRepository.manifestUrl,
      server: serverRepository.manifestUrl,
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
      strategy: 'azure-blob-sas',
      desktop: {
        containerUrl: azureSasUrls.desktop ? getAzureBlobContainerUrl(azureSasUrls.desktop) : null,
        redactedSasUrl: azureSasUrls.desktop ? sanitizeUrlForLogs(azureSasUrls.desktop) : null
      },
      server: {
        containerUrl: azureSasUrls.server ? getAzureBlobContainerUrl(azureSasUrls.server) : null,
        redactedSasUrl: azureSasUrls.server ? sanitizeUrlForLogs(azureSasUrls.server) : null
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
        assetsByPlatform: trigger.desktopSourceMode === DESKTOP_SOURCE_MODES.MAIN
          ? {}
          : desktopRelease.assetsByPlatform
      },
      server: {
        ...serverRelease
      }
    },
    store: {
      supportedWindowsTargets: [...storePackageConfig.supportedWindowsTargets],
      desktop: {
        storeConfigPath: storePackageConfig.desktop.storeConfigPath,
        buildCommand: storePackageConfig.desktop.buildCommand,
        runtimeInjectionPath: storePackageConfig.desktop.runtimeInjectionPath
      }
    },
    publication: {
      mode: publicationMode
    },
    release: {
      repository: packerRepository,
      tag: releaseTag,
      name: `Windows Store ${releaseTag}`,
      exists: releaseExists,
      url: existingRelease?.html_url ?? null,
      notesTitle: `Windows Store ${releaseTag}`
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
        workflow: 'package-release'
      },
      consumer: {
        repository: packerRepository,
        workflow: 'package-release'
      }
    }
  };
}
