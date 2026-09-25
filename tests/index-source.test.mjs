import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_INDEX_SOURCES,
  DEFAULT_INDEX_TIMEOUT_MS,
  fetchIndexManifest,
  resolveDlcIndexRelease,
  resolveIndexRelease
} from '../scripts/lib/index-source.mjs';

const INDEX_URL = 'https://dl-dlc.hagicode.com/index.json';

test('default version indexes have ordered public endpoints', () => {
  assert.deepEqual(DEFAULT_INDEX_SOURCES, {
    desktop: ['https://desktop.dl.hagicode.com/index.json', 'https://dl-desktop.hagicode.com/index.json'],
    service: ['https://server.dl.hagicode.com/index.json', 'https://dl-server.hagicode.com/index.json']
  });
});

const SERVER_MANIFEST = {
  versions: [{
    version: '1.2.3',
    assets: ['1.2.3/hagicode-1.2.3-win-x64-nort.zip']
  }]
};

function resolveServer(fetchImpl, selector = null) {
  return resolveIndexRelease({
    sourceType: 'service',
    indexUrls: DEFAULT_INDEX_SOURCES.service,
    selector,
    platforms: ['win-x64'],
    fetchImpl
  });
}

test('default index stops at the primary when it returns a readable manifest', async () => {
  const requests = [];
  const release = await resolveServer(async (url, { signal }) => {
    requests.push(url);
    assert.ok(signal);
    return Response.json(SERVER_MANIFEST);
  });
  assert.deepEqual(requests, [DEFAULT_INDEX_SOURCES.service[0]]);
  assert.equal(release.manifestUrl, requests[0]);
  assert.equal(release.version, '1.2.3');
});

test('default index falls back for network, HTTP, content type, and JSON errors', async (t) => {
  const failures = [
    ['network', () => { throw new Error('network unavailable'); }],
    ['HTTP', () => new Response('missing', { status: 503 })],
    ['body read', () => ({ text: async () => { throw new Error('stream interrupted'); } })],
    ['content type', () => new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } })],
    ['invalid JSON', () => new Response('{invalid', { headers: { 'content-type': 'application/json' } })]
  ];
  for (const [name, failure] of failures) {
    await t.test(name, async () => {
      const requests = [];
      const release = await resolveServer(async (url) => {
        requests.push(url);
        return requests.length === 1 ? failure() : Response.json(SERVER_MANIFEST);
      });
      assert.deepEqual(requests, DEFAULT_INDEX_SOURCES.service);
      assert.equal(release.manifestUrl, DEFAULT_INDEX_SOURCES.service[1]);
    });
  }
});

test('default index times out its primary before requesting the fallback', async () => {
  const requests = [];
  const keepAlive = setTimeout(() => {}, DEFAULT_INDEX_TIMEOUT_MS + 100);
  try {
    const release = await resolveServer((url, { signal }) => {
      requests.push(url);
      if (requests.length > 1) return Promise.resolve(Response.json(SERVER_MANIFEST));
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    assert.deepEqual(requests, DEFAULT_INDEX_SOURCES.service);
    assert.equal(release.manifestUrl, DEFAULT_INDEX_SOURCES.service[1]);
    assert.equal(DEFAULT_INDEX_TIMEOUT_MS, 10_000);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('default index reports both URL-specific failures', async () => {
  await assert.rejects(
    resolveServer(async (url) => url === DEFAULT_INDEX_SOURCES.service[0]
      ? new Response('unavailable', { status: 502 })
      : new Response('{', { headers: { 'content-type': 'application/json' } })),
    (error) => {
      assert.match(error.message, /server\.dl\.hagicode\.com\/index\.json.*502/);
      assert.match(error.message, /dl-server\.hagicode\.com\/index\.json.*invalid JSON/);
      return true;
    }
  );
});

test('a retrieved manifest with a missing selector or asset never falls back', async () => {
  for (const [manifest, selector, expected] of [
    [SERVER_MANIFEST, '9.9.9', /Unable to find Server version/],
    [{ versions: [{ version: '1.2.3', assets: ['other.zip'] }] }, null, /Missing server release asset/]
  ]) {
    const requests = [];
    await assert.rejects(
      resolveServer(async (url) => {
        requests.push(url);
        return Response.json(manifest);
      }, selector),
      expected
    );
    assert.deepEqual(requests, [DEFAULT_INDEX_SOURCES.service[0]]);
  }
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
