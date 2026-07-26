import { createWriteStream } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

function requireNonEmpty(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

/** @deprecated Legacy Azure SAS helper — kept for optional index/download fallback. */
export function parseAzureSasUrl(value) {
  const normalized = requireNonEmpty(value, 'Azure SAS URL');
  const parsed = new URL(normalized);
  if (!parsed.search) {
    throw new Error('Azure SAS URL must include a query string.');
  }
  return parsed;
}

export function sanitizeUrlForLogs(url) {
  if (!url) {
    return '[empty-url]';
  }

  try {
    const parsed = new URL(url);
    return parsed.search ? `${parsed.origin}${parsed.pathname}?<sas-token-redacted>` : url;
  } catch {
    const normalized = String(url);
    const queryIndex = normalized.indexOf('?');
    return queryIndex >= 0 ? `${normalized.slice(0, queryIndex)}?<sas-token-redacted>` : normalized;
  }
}

/** @deprecated Legacy Azure SAS helper — kept for optional index/download fallback. */
export function getAzureBlobContainerUrl(sasUrl) {
  const parsed = parseAzureSasUrl(sasUrl);
  return `${parsed.origin}${parsed.pathname.replace(/\/?$/, '/')}`;
}

/** @deprecated Legacy Azure SAS helper — kept for optional index/download fallback. */
export function buildSignedBlobUrl(sasUrl, blobPath) {
  const parsed = parseAzureSasUrl(sasUrl);
  const containerPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${containerPath}/${String(blobPath).replace(/^\/+/, '')}`;
  return parsed.toString();
}

export function composePublicAssetUrl(publicBaseUrl, assetPath) {
  const base = String(publicBaseUrl ?? '').trim().replace(/\/+$/, '');
  const normalizedPath = String(assetPath ?? '').replace(/^\/+/, '');
  if (!base || !normalizedPath) {
    return null;
  }
  return `${base}/${normalizedPath}`;
}

/**
 * Resolve packaging-input download URL.
 * Priority: override → directUrl → publicBase+path → optional legacy SAS.
 */
export function resolveAssetDownloadUrl({ asset, sasUrl, overrideSource, publicBaseUrl } = {}) {
  if (overrideSource) {
    if (/^(?:https?|file):\/\//i.test(overrideSource)) {
      return overrideSource;
    }
    return path.resolve(overrideSource);
  }

  if (asset?.directUrl) {
    return asset.directUrl;
  }

  const composed = composePublicAssetUrl(publicBaseUrl, asset?.path);
  if (composed) {
    return composed;
  }

  const assetPath = String(asset?.path ?? '').replace(/^\/+/, '');
  if (sasUrl && assetPath) {
    return buildSignedBlobUrl(sasUrl, assetPath);
  }

  const name = asset?.name ?? '<unknown>';
  throw new Error(
    `Unable to resolve download source for asset ${name}. ` +
      'Provide an override source, asset.directUrl, ' +
      'public base URL (e.g. WIN_STORE_PACKER_SERVER_PUBLIC_BASE_URL / WIN_STORE_PACKER_DLC_PUBLIC_BASE_URL) + asset.path, ' +
      'or a legacy Azure SAS URL.'
  );
}

export async function downloadFromSource({ sourceUrl, destinationPath, fetchImpl = globalThis.fetch }) {
  if (/^file:\/\//i.test(sourceUrl)) {
    await copyFile(new URL(sourceUrl), destinationPath);
    return destinationPath;
  }

  if (/^(?:[A-Za-z]:\\|\/)/.test(sourceUrl)) {
    await copyFile(sourceUrl, destinationPath);
    return destinationPath;
  }

  if (!/^https?:\/\//i.test(sourceUrl)) {
    throw new Error(`Unsupported asset source: ${sourceUrl}`);
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to download remote assets.');
  }

  const response = await fetchImpl(sourceUrl, {
    headers: {
      Accept: '*/*',
      'User-Agent': 'win-store-packer-automation'
    }
  });

  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(`Failed to download ${sanitizeUrlForLogs(sourceUrl)}: ${response.status} ${body}`);
  }

  await pipeline(response.body, createWriteStream(destinationPath));
  return destinationPath;
}
