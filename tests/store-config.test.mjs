import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStorePackageConfig, normalizeStorePackageVersion, resolveStoreSigningConfig } from '../scripts/lib/store-config.mjs';

test('normalizeStorePackageVersion derives a four-part Windows package version from a Desktop tag', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  assert.equal(normalizeStorePackageVersion('v0.1.56', storePackageConfig.packageVersion), '0.1.56.0');
});

test('normalizeStorePackageVersion rejects non-stable Desktop tags', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  assert.throws(
    () => normalizeStorePackageVersion('v0.1.56-beta.1', storePackageConfig.packageVersion),
    /Store-safe numeric package version/
  );
});

test('resolveStoreSigningConfig reports missing Azure signing inputs when signing is required', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  assert.throws(
    () =>
      resolveStoreSigningConfig({
        storePackageConfig,
        signingMode: 'required',
        env: {}
      }),
    /Missing Store signing configuration/
  );
});
