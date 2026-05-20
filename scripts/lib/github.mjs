import { readFile } from 'node:fs/promises';

const API_ROOT = 'https://api.github.com';

function getHeaders(token, contentType) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'win-store-packer-automation'
  };
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function normalizeReleaseAsset(asset) {
  return {
    ...asset,
    downloadUrl: asset?.browser_download_url ?? asset?.url ?? null
  };
}

function normalizeRelease(release) {
  if (!release || typeof release !== 'object') {
    return release;
  }
  return {
    ...release,
    assets: Array.isArray(release.assets) ? release.assets.map(normalizeReleaseAsset) : []
  };
}

async function requestJson(endpoint, token, { allowNotFound = false, method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(`${API_ROOT}${endpoint}`, {
    method,
    headers: {
      ...getHeaders(token, body ? 'application/json' : undefined)
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  if (allowNotFound && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`GitHub API request failed (${response.status}) for ${endpoint}: ${responseBody}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export async function getReleaseByTag(repository, tag, token, { allowNotFound = false, fetchImpl = globalThis.fetch } = {}) {
  return normalizeRelease(
    await requestJson(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, token, {
      allowNotFound,
      fetchImpl
    })
  );
}

export async function findReleaseByTag(repository, tag, token, { fetchImpl = globalThis.fetch } = {}) {
  return getReleaseByTag(repository, tag, token, { allowNotFound: true, fetchImpl });
}

export async function createRelease(repository, token, payload, { fetchImpl = globalThis.fetch } = {}) {
  return normalizeRelease(
    await requestJson(`/repos/${repository}/releases`, token, {
      method: 'POST',
      body: payload,
      fetchImpl
    })
  );
}

export async function updateRelease(repository, releaseId, token, payload, { fetchImpl = globalThis.fetch } = {}) {
  return normalizeRelease(
    await requestJson(`/repos/${repository}/releases/${releaseId}`, token, {
      method: 'PATCH',
      body: payload,
      fetchImpl
    })
  );
}

export async function deleteReleaseAsset(repository, assetId, token, { fetchImpl = globalThis.fetch } = {}) {
  await requestJson(`/repos/${repository}/releases/assets/${assetId}`, token, {
    method: 'DELETE',
    fetchImpl
  });
}

export async function upsertReleaseNotes(repository, tag, token, { name, body, fetchImpl = globalThis.fetch } = {}) {
  const existingRelease = await findReleaseByTag(repository, tag, token, { fetchImpl });
  if (!existingRelease) {
    return {
      action: 'created',
      release: await createRelease(
        repository,
        token,
        {
          tag_name: tag,
          name: name ?? tag,
          body,
          draft: false,
          prerelease: false
        },
        { fetchImpl }
      )
    };
  }

  return {
    action: 'updated',
    release: await updateRelease(
      repository,
      existingRelease.id,
      token,
      {
        name: name ?? existingRelease.name ?? tag,
        body,
        draft: existingRelease.draft ?? false,
        prerelease: existingRelease.prerelease ?? false
      },
      { fetchImpl }
    )
  };
}

function resolveUploadUrl(uploadUrl, fileName) {
  const normalized = String(uploadUrl).replace(/\{.*$/, '');
  const separator = normalized.includes('?') ? '&' : '?';
  return `${normalized}${separator}name=${encodeURIComponent(fileName)}`;
}

export async function uploadReleaseAsset({
  release,
  repository,
  filePath,
  fileName,
  contentType = 'application/octet-stream',
  token,
  fetchImpl = globalThis.fetch
}) {
  const existingAsset = Array.isArray(release?.assets)
    ? release.assets.find((asset) => asset?.name === fileName)
    : null;

  if (existingAsset?.id) {
    await deleteReleaseAsset(repository, existingAsset.id, token, { fetchImpl });
  }

  const uploadUrl = resolveUploadUrl(release?.upload_url, fileName);
  const body = await readFile(filePath);
  const response = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: getHeaders(token, contentType),
    body
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`GitHub release asset upload failed (${response.status}) for ${fileName}: ${responseBody}`);
  }

  return normalizeReleaseAsset(await response.json());
}
