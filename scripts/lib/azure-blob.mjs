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

export function getAzureBlobContainerUrl(sasUrl) {
  const parsed = parseAzureSasUrl(sasUrl);
  return `${parsed.origin}${parsed.pathname.replace(/\/?$/, '/')}`;
}

export function buildSignedBlobUrl(sasUrl, blobPath) {
  const parsed = parseAzureSasUrl(sasUrl);
  const containerPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${containerPath}/${String(blobPath).replace(/^\/+/, '')}`;
  return parsed.toString();
}

export function resolveAssetDownloadUrl({ asset, sasUrl, overrideSource }) {
  if (overrideSource) {
    if (/^(?:https?|file):\/\//i.test(overrideSource)) {
      return overrideSource;
    }
    return path.resolve(overrideSource);
  }

  if (asset?.directUrl) {
    return asset.directUrl;
  }

  if (!sasUrl) {
    throw new Error(`Missing Azure SAS URL for asset ${asset?.name ?? '<unknown>'}.`);
  }

  return buildSignedBlobUrl(sasUrl, asset?.path);
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
