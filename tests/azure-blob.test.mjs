import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAssetDownloadUrl } from '../scripts/lib/azure-blob.mjs';

test('resolveAssetDownloadUrl prefers Azure blob path over public directUrl when SAS is available', () => {
  const sasUrl = 'https://example.blob.core.windows.net/server?sp=racwl&sig=test-token';
  const downloadUrl = resolveAssetDownloadUrl({
    asset: {
      name: 'hagicode-0.1.0-beta.34-win-x64-nort.zip',
      path: '0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip',
      directUrl: 'https://server.dl.hagicode.com/0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip'
    },
    sasUrl
  });

  assert.equal(
    downloadUrl,
    'https://example.blob.core.windows.net/server/0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip?sp=racwl&sig=test-token'
  );
});

test('resolveAssetDownloadUrl falls back to directUrl when Azure blob path is unavailable', () => {
  const downloadUrl = resolveAssetDownloadUrl({
    asset: {
      name: 'hagicode-0.1.0-beta.34-win-x64-nort.zip',
      directUrl: 'https://server.dl.hagicode.com/0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip'
    },
    sasUrl: 'https://example.blob.core.windows.net/server?sp=racwl&sig=test-token'
  });

  assert.equal(
    downloadUrl,
    'https://server.dl.hagicode.com/0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip'
  );
});
