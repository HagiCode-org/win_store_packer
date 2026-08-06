import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_INDEX_SOURCES,
  fetchIndexManifest,
  resolveDlcIndexRelease
} from '../scripts/lib/index-source.mjs';

const INDEX_URL = 'https://dl-dlc.hagicode.com/index.json';

test('default version indexes use Cloudflare public index.json endpoints', () => {
  assert.deepEqual(DEFAULT_INDEX_SOURCES, {
    desktop: 'https://dl-desktop.hagicode.com/index.json',
    service: 'https://dl-server.hagicode.com/index.json'
  });
});

test('fetchIndexManifest identifies the URL when network access fails', async () => {
  await assert.rejects(
    fetchIndexManifest(INDEX_URL, {
      fetchImpl: async () => {
        throw new Error('fetch failed');
      }
    }),
    new RegExp(`Failed to fetch index manifest ${INDEX_URL}: fetch failed`)
  );
});

test('resolveDlcIndexRelease consumes structured DLC artifact download metadata', async () => {
  const directUrl = 'https://dl-dlc.hagicode.com/turbo-engine/1.2.3/hagicode-dlc-turbo-engine-1.2.3-win-x64-nort.zip';
  const manifest = {
    '$schema': 'https://dl-dlc.hagicode.com/index.schema.json',
    updatedAt: '2026-08-05T00:00:00.000Z',
    dlcs: [
      {
        dlcName: 'turbo-engine',
        versions: [
          {
            version: '1.2.3',
            artifacts: [
              {
                name: 'hagicode-dlc-turbo-engine-1.2.3-win-x64-nort.zip',
                path: 'turbo-engine/1.2.3/hagicode-dlc-turbo-engine-1.2.3-win-x64-nort.zip',
                size: 123,
                lastModified: '2026-08-05T00:00:00.000Z',
                directUrl,
                torrentUrl: `${directUrl}.torrent`,
                downloadSources: [
                  {
                    kind: 'official',
                    label: 'Official',
                    url: directUrl,
                    primary: true,
                    webSeed: true
                  }
                ],
                webSeeds: [directUrl]
              }
            ]
          }
        ]
      }
    ]
  };

  const release = await resolveDlcIndexRelease({
    indexUrl: INDEX_URL,
    dlcName: 'turbo-engine',
    directoryId: 'turbo-engine',
    platforms: ['win-x64'],
    fetchImpl: async (url) => {
      assert.equal(url, INDEX_URL);
      return new Response(JSON.stringify(manifest), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  assert.equal(release.version, '1.2.3');
  assert.deepEqual(release.assetsByPlatform['win-x64'], {
    name: 'hagicode-dlc-turbo-engine-1.2.3-win-x64-nort.zip',
    path: 'turbo-engine/1.2.3/hagicode-dlc-turbo-engine-1.2.3-win-x64-nort.zip',
    size: 123,
    directUrl,
    torrentUrl: `${directUrl}.torrent`,
    downloadSources: manifest.dlcs[0].versions[0].artifacts[0].downloadSources,
    webSeeds: [directUrl],
    lastModified: '2026-08-05T00:00:00.000Z',
    sha256: null
  });
});

test('resolveDlcIndexRelease can use the official source when directUrl is absent', async () => {
  const officialUrl = 'https://dl-dlc.hagicode.com/turbo-engine/1.2.3/package.zip';
  const release = await resolveDlcIndexRelease({
    indexUrl: INDEX_URL,
    dlcName: 'turbo-engine',
    directoryId: 'turbo-engine',
    platforms: ['win-x64'],
    fetchImpl: async () =>
      Response.json({
        updatedAt: '2026-08-05T00:00:00.000Z',
        dlcs: [
          {
            dlcName: 'turbo-engine',
            versions: [
              {
                version: '1.2.3',
                artifacts: [
                  {
                    name: 'hagicode-dlc-turbo-engine-1.2.3-win-x64-nort.zip',
                    path: 'turbo-engine/1.2.3/package.zip',
                    downloadSources: [
                      {
                        kind: 'official',
                        url: officialUrl
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      })
  });

  assert.equal(release.assetsByPlatform['win-x64'].directUrl, officialUrl);
  assert.equal(release.assetsByPlatform['win-x64'].torrentUrl, `${officialUrl}.torrent`);
});
