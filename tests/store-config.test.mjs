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

test('resolveStoreSigningConfig accepts a publisher subject wrapped in quotes', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  const signingConfig = resolveStoreSigningConfig({
    storePackageConfig,
    signingMode: 'required',
    env: {
      AZURE_CODESIGN_APPX_PUBLISHER: '"CN=Hagicode, O=HagiCode, C=US"',
      AZURE_CLIENT_ID: 'client-id',
      AZURE_TENANT_ID: 'tenant-id',
      AZURE_SUBSCRIPTION_ID: 'subscription-id',
      AZURE_CODESIGN_ENDPOINT: 'https://example.test',
      AZURE_CODESIGN_ACCOUNT_NAME: 'account-name',
      AZURE_CODESIGN_CERTIFICATE_PROFILE_NAME: 'profile-name'
    }
  });

  assert.equal(signingConfig.publisher, 'CN=Hagicode, O=HagiCode, C=US');
});

test('resolveStoreSigningConfig rejects a publisher that is not a valid distinguished name', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  assert.throws(
    () =>
      resolveStoreSigningConfig({
        storePackageConfig,
        signingMode: 'required',
        env: {
          AZURE_CODESIGN_APPX_PUBLISHER: 'not-a-distinguished-name',
          AZURE_CLIENT_ID: 'client-id',
          AZURE_TENANT_ID: 'tenant-id',
          AZURE_SUBSCRIPTION_ID: 'subscription-id',
          AZURE_CODESIGN_ENDPOINT: 'https://example.test',
          AZURE_CODESIGN_ACCOUNT_NAME: 'account-name',
          AZURE_CODESIGN_CERTIFICATE_PROFILE_NAME: 'profile-name'
        }
      }),
    /Invalid Store signing publisher/
  );
});
