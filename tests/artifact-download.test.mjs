import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  resolveAssetDownloadUrl,
  composePublicAssetUrl,
  sanitizeUrlForLogs
} from '../scripts/lib/artifact-download.mjs';

const sampleAsset = {
  name: 'hagicode-0.1.0-beta.34-win-x64-nort.zip',
  path: '0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip',
  directUrl: 'https://server.dl.hagicode.com/0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip'
};

const legacySas = 'https://example.blob.core.windows.net/server?sp=racwl&sig=test-token';

test('resolveAssetDownloadUrl prefers directUrl over legacy Azure SAS', () => {
  const downloadUrl = resolveAssetDownloadUrl({
    asset: sampleAsset,
    sasUrl: legacySas
  });

  assert.equal(downloadUrl, sampleAsset.directUrl);
});

test('resolveAssetDownloadUrl composes publicBase + path when directUrl missing', () => {
  const downloadUrl = resolveAssetDownloadUrl({
    asset: {
      name: sampleAsset.name,
      path: sampleAsset.path
    },
    publicBaseUrl: 'https://server.dl.hagicode.com/'
  });

  assert.equal(
    downloadUrl,
    'https://server.dl.hagicode.com/0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip'
  );
});

test('resolveAssetDownloadUrl prefers override over directUrl, public base, and SAS', () => {
  const override = 'https://override.example/custom.zip';
  const downloadUrl = resolveAssetDownloadUrl({
    asset: sampleAsset,
    sasUrl: legacySas,
    publicBaseUrl: 'https://server.dl.hagicode.com',
    overrideSource: override
  });

  assert.equal(downloadUrl, override);
});

test('resolveAssetDownloadUrl resolves local path override', () => {
  const downloadUrl = resolveAssetDownloadUrl({
    asset: sampleAsset,
    overrideSource: './fixtures/sample.zip'
  });

  assert.equal(downloadUrl, path.resolve('./fixtures/sample.zip'));
});

test('resolveAssetDownloadUrl falls back to legacy SAS when no public source', () => {
  const downloadUrl = resolveAssetDownloadUrl({
    asset: {
      name: sampleAsset.name,
      path: sampleAsset.path
    },
    sasUrl: legacySas
  });

  assert.equal(
    downloadUrl,
    'https://example.blob.core.windows.net/server/0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip?sp=racwl&sig=test-token'
  );
});

test('resolveAssetDownloadUrl fails clearly when no source is available', () => {
  assert.throws(
    () =>
      resolveAssetDownloadUrl({
        asset: { name: 'missing.zip' }
      }),
    /Unable to resolve download source for asset missing\.zip/
  );
});

test('composePublicAssetUrl joins base and path without duplicate slashes', () => {
  assert.equal(
    composePublicAssetUrl('https://cdn.example/', '/a/b.zip'),
    'https://cdn.example/a/b.zip'
  );
  assert.equal(composePublicAssetUrl('', 'a/b.zip'), null);
  assert.equal(composePublicAssetUrl('https://cdn.example', ''), null);
});

test('sanitizeUrlForLogs redacts query strings', () => {
  assert.equal(
    sanitizeUrlForLogs('https://example.blob.core.windows.net/server/file.zip?sig=secret'),
    'https://example.blob.core.windows.net/server/file.zip?<sas-token-redacted>'
  );
});
