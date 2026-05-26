export const DEFAULT_PLATFORMS = ['win-x64'];

const PLATFORM_MAP = {
  'win-x64': {
    id: 'win-x64',
    runner: 'windows-2025',
    runtimeKey: 'win-x64-nort',
    desktopAssetPatterns: [
      /^hagicode\.desktop\..*-unpacked\.zip$/i,
      /^hagicode\.desktop\..*\.msix$/i,
      /^hagicode\.desktop\..*\.exe$/i
    ]
  }
};

export function getPlatformConfig(platformId) {
  const platform = PLATFORM_MAP[String(platformId).toLowerCase()];
  if (!platform) {
    throw new Error(`Unsupported platform: ${platformId}`);
  }
  return platform;
}

export function getSupportedPlatforms() {
  return Object.keys(PLATFORM_MAP);
}

export function normalizePlatforms(value, fallback = DEFAULT_PLATFORMS) {
  if (!value || (typeof value === 'string' && value.trim() === '')) {
    return [...fallback];
  }

  const rawValues = Array.isArray(value)
    ? value
    : String(value)
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);

  const normalized = [];
  for (const rawValue of rawValues) {
    const lowerValue = rawValue.toLowerCase();
    getPlatformConfig(lowerValue);
    if (!normalized.includes(lowerValue)) {
      normalized.push(lowerValue);
    }
  }

  return normalized;
}

export function createPlatformMatrix(platforms) {
  return {
    include: platforms.map((platformId) => {
      const platform = getPlatformConfig(platformId);
      return {
        platform: platform.id,
        runner: platform.runner,
        runtimeKey: platform.runtimeKey
      };
    })
  };
}

export function stripGitRef(value) {
  return String(value).replace(/^refs\/tags\//, '').trim();
}

export function normalizeGitTag(value) {
  const normalized = stripGitRef(value);
  if (!normalized) {
    throw new Error('Git tags must be non-empty.');
  }
  return `v${normalized.replace(/^v/i, '')}`;
}

export function normalizeReleaseTagComponent(value) {
  return normalizeGitTag(value).replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function deriveStoreReleaseTag(desktopVersion, serverVersion) {
  return `store-desktop-${normalizeReleaseTagComponent(desktopVersion)}-server-${normalizeReleaseTagComponent(serverVersion)}`;
}

export function buildStoreArtifactName(releaseTag, platformId, variant = null, extension = '.appx') {
  const safeReleaseTag = String(releaseTag).replace(/[^A-Za-z0-9._-]+/g, '-');
  const suffix = variant ? `-${String(variant).replace(/[^A-Za-z0-9._-]+/g, '-')}` : '';
  const normalizedExtension = String(extension || '.appx').startsWith('.')
    ? String(extension || '.appx').toLowerCase()
    : `.${String(extension || 'appx').toLowerCase()}`;
  return `hagicode-store-${safeReleaseTag}-${platformId}${suffix}${normalizedExtension}`;
}

export function matchDesktopAssetForPlatform(assets, platformId) {
  const platform = getPlatformConfig(platformId);
  for (const pattern of platform.desktopAssetPatterns) {
    const candidates = assets.filter((asset) => pattern.test(asset.name));
    if (candidates.length > 0) {
      return candidates.sort((left, right) => left.name.localeCompare(right.name))[0];
    }
  }

  throw new Error(
    `Missing Desktop release asset for ${platformId}. Expected one of: ${platform.desktopAssetPatterns.map((pattern) => pattern.source).join(', ')}`
  );
}

export function matchServerAssetForPlatform(assets, platformId) {
  const platform = getPlatformConfig(platformId);
  const lowerRuntimeKey = platform.runtimeKey.toLowerCase();
  const candidates = assets.filter((asset) => {
    const name = asset.name.toLowerCase();
    return name.includes(lowerRuntimeKey) && (name.endsWith('.zip') || name.endsWith('.tar.gz'));
  });

  if (candidates.length === 0) {
    throw new Error(`Missing server release asset for ${platformId}. Expected an asset containing ${platform.runtimeKey}.`);
  }

  return candidates.sort((left, right) => left.name.localeCompare(right.name))[0];
}
