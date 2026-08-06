import { matchDesktopAssetForPlatform, matchDlcAssetForPlatform, matchServerAssetForPlatform, stripGitRef } from './platforms.mjs';

export const DEFAULT_INDEX_SOURCES = Object.freeze({
  desktop: 'https://dl-desktop.hagicode.com/index.json',
  service: 'https://dl-server.hagicode.com/index.json'
});

export const DEFAULT_INDEX_MANIFEST_PATH = 'index.json';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getFetch(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to read index manifests.');
  }
  return fetchImpl;
}

function normalizeSelectorValue(value) {
  return stripGitRef(value).trim();
}

function compareNumeric(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return compareNumeric(left, 0) - compareNumeric(right, 0);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
}

function parseVersion(value) {
  const normalized = normalizeSelectorValue(value).replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(normalized);
  if (!match) {
    return {
      raw: normalized,
      numeric: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
      prerelease: null,
      valid: false
    };
  }

  return {
    raw: normalized,
    numeric: match.slice(1, 4).map((entry) => Number.parseInt(entry, 10)),
    prerelease: match[4] ? match[4].split('.') : null,
    valid: true
  };
}

export function compareNormalizedVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    const diff = leftVersion.numeric[index] - rightVersion.numeric[index];
    if (diff !== 0) {
      return diff;
    }
  }

  if (!leftVersion.prerelease && !rightVersion.prerelease) {
    return 0;
  }
  if (!leftVersion.prerelease) {
    return 1;
  }
  if (!rightVersion.prerelease) {
    return -1;
  }

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }

    const diff = compareIdentifier(leftIdentifier, rightIdentifier);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

export function normalizeVersionSelector(selector) {
  if (selector === undefined || selector === null || String(selector).trim() === '') {
    return null;
  }

  const normalized = normalizeSelectorValue(selector);
  const withoutV = normalized.replace(/^v/i, '');
  const withV = `v${withoutV}`;
  return {
    raw: String(selector),
    normalized,
    candidates: unique([normalized, withoutV, withV])
  };
}

export function selectorMatchesVersion(selector, version) {
  if (!selector) {
    return true;
  }
  const normalizedVersion = normalizeVersionSelector(version);
  return selector.candidates.some((candidate) => normalizedVersion?.candidates.includes(candidate));
}

function normalizeFileAsset(entry) {
  if (typeof entry === 'string') {
    const normalizedPath = entry.replace(/^\/+/, '');
    return {
      name: normalizedPath.split('/').pop(),
      path: normalizedPath,
      size: null,
      directUrl: null,
      lastModified: null
    };
  }

  return {
    ...entry,
    name: entry.name ?? entry.fileName ?? String(entry.path ?? '').split('/').pop(),
    path: entry.path ?? entry.blobPath ?? null,
    directUrl: entry.directUrl ?? entry.downloadUrl ?? entry.url ?? null
  };
}

export function getVersionEntries(manifest) {
  const entries = manifest?.packages ?? manifest?.versions;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Index manifest does not contain any version entries.');
  }
  return entries;
}

export function getAssetEntries(versionEntry) {
  const candidates = [versionEntry?.assets, versionEntry?.downloads, versionEntry?.artifacts, versionEntry?.files];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate.map(normalizeFileAsset);
    }
  }
  throw new Error(`Index version ${versionEntry?.version ?? 'unknown'} does not expose any assets.`);
}

function resolveLatestVersionEntry(entries) {
  return [...entries].sort((left, right) => compareNormalizedVersions(right.version, left.version))[0];
}

export function resolveVersionEntry({ manifest, selector, sourceLabel }) {
  const entries = getVersionEntries(manifest);
  const normalizedSelector = normalizeVersionSelector(selector);
  if (!normalizedSelector) {
    return resolveLatestVersionEntry(entries);
  }

  const matchedEntry = entries.find((entry) => selectorMatchesVersion(normalizedSelector, entry.version));
  if (!matchedEntry) {
    throw new Error(`Unable to find ${sourceLabel} version matching selector "${selector}" in ${sourceLabel} index.`);
  }

  return matchedEntry;
}

function ensureAddressableAsset(asset, platformId, sourceLabel, version) {
  if (!asset?.path && !asset?.directUrl) {
    throw new Error(
      `${sourceLabel} asset ${asset?.name ?? '<unknown>'} for ${platformId} in version ${version} cannot be downloaded because it has neither an index path nor direct URL.`
    );
  }
  return asset;
}

function mapAssetRecord(asset) {
  const officialSource = Array.isArray(asset.downloadSources)
    ? asset.downloadSources.find((source) => source?.kind === 'official' && source.url)
    : null;
  const directUrl = asset.directUrl || officialSource?.url || null;
  return {
    name: asset.name,
    path: asset.path,
    size: asset.size ?? null,
    directUrl,
    torrentUrl: asset.torrentUrl ?? (directUrl ? `${directUrl}.torrent` : null),
    downloadSources: Array.isArray(asset.downloadSources) ? asset.downloadSources : null,
    webSeeds: Array.isArray(asset.webSeeds) ? asset.webSeeds : null,
    lastModified: asset.lastModified ?? asset.updatedAt ?? null,
    sha256: asset.sha256 ?? null
  };
}

export function mapIndexAssetsByPlatform({ sourceType, versionEntry, platforms }) {
  const allAssets = getAssetEntries(versionEntry);
  const matcher = sourceType === 'desktop' ? matchDesktopAssetForPlatform : matchServerAssetForPlatform;
  const sourceLabel = sourceType === 'desktop' ? 'Desktop' : 'Server';
  const assetsByPlatform = {};
  for (const platformId of platforms) {
    const matchedAsset = ensureAddressableAsset(
      matcher(allAssets, platformId),
      platformId,
      sourceLabel,
      versionEntry.version
    );
    assetsByPlatform[platformId] = mapAssetRecord(matchedAsset);
  }
  return assetsByPlatform;
}

function getDlcEntries(manifest) {
  if (!Array.isArray(manifest?.dlcs) || manifest.dlcs.length === 0) {
    throw new Error('DLC index manifest does not contain any DLC entries.');
  }
  return manifest.dlcs;
}

function getDlcVersionEntries(dlcEntry, dlcName) {
  if (!Array.isArray(dlcEntry?.versions) || dlcEntry.versions.length === 0) {
    throw new Error(`DLC index entry ${JSON.stringify(dlcName)} does not contain any versions.`);
  }
  return dlcEntry.versions;
}

function resolveDlcEntry(manifest, dlcName) {
  const normalizedDlcName = normalizeSelectorValue(dlcName);
  const entry = getDlcEntries(manifest).find((candidate) => normalizeSelectorValue(candidate?.dlcName) === normalizedDlcName);
  if (!entry) {
    throw new Error(`Unable to find DLC ${JSON.stringify(dlcName)} in the DLC index.`);
  }
  return entry;
}

function resolveLatestDlcVersionEntry(dlcEntry, dlcName) {
  return [...getDlcVersionEntries(dlcEntry, dlcName)].sort((left, right) => compareNormalizedVersions(right.version, left.version))[0];
}

export function resolveDlcVersionEntry({ manifest, dlcName, selector = null }) {
  const dlcEntry = resolveDlcEntry(manifest, dlcName);
  const versions = getDlcVersionEntries(dlcEntry, dlcName);
  const normalizedSelector = normalizeVersionSelector(selector);
  if (!normalizedSelector) {
    return {
      dlcEntry,
      versionEntry: resolveLatestDlcVersionEntry(dlcEntry, dlcName)
    };
  }

  const versionEntry = versions.find((entry) => selectorMatchesVersion(normalizedSelector, entry.version));
  if (!versionEntry) {
    throw new Error(`Unable to find DLC ${JSON.stringify(dlcName)} version matching selector ${JSON.stringify(selector)}.`);
  }

  return {
    dlcEntry,
    versionEntry
  };
}

export function mapDlcAssetsByPlatform({ dlcName, directoryId, versionEntry, platforms }) {
  const allAssets = getAssetEntries(versionEntry);
  const assetsByPlatform = {};
  for (const platformId of platforms) {
    const matchedAsset = ensureAddressableAsset(
      matchDlcAssetForPlatform(allAssets, platformId, { directoryId }),
      platformId,
      `DLC ${dlcName}`,
      versionEntry.version
    );
    assetsByPlatform[platformId] = mapAssetRecord(matchedAsset);
  }
  return assetsByPlatform;
}

export async function fetchIndexManifest(indexUrl, { fetchImpl } = {}) {
  const response = await getFetch(fetchImpl)(indexUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'win-store-packer-automation'
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to read index manifest ${indexUrl}: ${response.status} ${body}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (!contentType.toLowerCase().includes('json')) {
    throw new Error(
      `Index manifest ${indexUrl} returned ${contentType || 'unknown'} content instead of JSON. ` +
      `Expected JSON but received: ${body.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(
      `Index manifest ${indexUrl} returned invalid JSON: ${error.message}. ` +
      `Received: ${body.slice(0, 500)}`
    );
  }
}

export async function resolveIndexRelease({
  sourceType,
  indexUrl,
  manifestUrl = indexUrl,
  selector,
  platforms,
  fetchImpl,
  sourceAuthority = 'cloudflare-index',
  manifestPath = null
}) {
  const manifest = await fetchIndexManifest(indexUrl, { fetchImpl });
  const versionEntry = resolveVersionEntry({
    manifest,
    selector,
    sourceLabel: sourceType === 'desktop' ? 'Desktop' : 'Server'
  });

  return {
    sourceType: 'index',
    sourceAuthority,
    manifestUrl,
    manifestPath,
    selector: normalizeVersionSelector(selector)?.normalized ?? null,
    version: versionEntry.version,
    updatedAt: manifest.updatedAt ?? null,
    assetsByPlatform: mapIndexAssetsByPlatform({
      sourceType,
      versionEntry,
      platforms
    })
  };
}

export async function resolveDlcIndexRelease({
  indexUrl,
  manifestUrl = indexUrl,
  dlcName,
  directoryId,
  selector = null,
  platforms,
  fetchImpl,
  sourceAuthority = 'cloudflare-index',
  manifestPath = null
}) {
  const manifest = await fetchIndexManifest(indexUrl, { fetchImpl });
  const { dlcEntry, versionEntry } = resolveDlcVersionEntry({ manifest, dlcName, selector });

  return {
    sourceType: 'index',
    sourceAuthority,
    manifestUrl,
    manifestPath,
    selector: normalizeVersionSelector(selector)?.normalized ?? null,
    dlcName: dlcEntry.dlcName,
    version: versionEntry.version,
    updatedAt: manifest.updatedAt ?? null,
    assetsByPlatform: mapDlcAssetsByPlatform({
      dlcName: dlcEntry.dlcName,
      directoryId,
      versionEntry,
      platforms
    })
  };
}
