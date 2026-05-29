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

export function normalizeTriggerInputs({ eventName, eventPayload, defaultPlatforms = DEFAULT_PLATFORMS }) {
  const inputs = eventPayload?.inputs ?? {};
  const clientPayload = eventPayload?.client_payload ?? {};
  const desktopSelector = coalesce(inputs.desktop_version, inputs.desktop_tag, clientPayload.desktopVersion, clientPayload.desktopTag);
  const serverSelector = coalesce(inputs.server_version, inputs.server_tag, clientPayload.serverVersion, clientPayload.serverTag);
  const platforms = coalesce(inputs.platforms, clientPayload.platforms);
  const forceRebuild = normalizeBoolean(coalesce(inputs.force_rebuild, clientPayload.forceRebuild, clientPayload.force_rebuild), false);
  const dryRun = normalizeBoolean(coalesce(inputs.dry_run, clientPayload.dryRun, clientPayload.dry_run), false);

  return {
    triggerType: eventName,
    desktopSelector,
    serverSelector,
    selectedPlatforms: normalizePlatforms(platforms, defaultPlatforms),
    forceRebuild,
    dryRun,
    rawInputs: {
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
    resolveIndexRelease({
      sourceType: 'desktop',
      indexUrl: desktopRepository.requestUrl,
      manifestUrl: desktopRepository.manifestUrl,
      sourceAuthority: desktopRepository.sourceAuthority,
      manifestPath: desktopRepository.manifestPath,
      selector: trigger.desktopSelector,
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

  const desktopTag = normalizeGitTag(desktopRelease.version);
  const releaseTag = deriveStoreReleaseTag(desktopRelease.version, serverRelease.version);
  const existingRelease = await findStoreRelease(packerRepository, releaseTag, token, { fetchImpl });
  const releaseExists = Boolean(existingRelease);
  const shouldBuild = !releaseExists || trigger.forceRebuild;
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
        tag: desktopTag
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
