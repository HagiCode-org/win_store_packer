import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStorePackageConfig, normalizeStorePackageVersion, resolveStoreSigningConfig } from '../scripts/lib/store-config.mjs';

test('normalizeStorePackageVersion derives a four-part Windows package version from a Desktop tag', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  assert.equal(normalizeStorePackageVersion('v0.1.56', storePackageConfig.packageVersion), '0.1.56.0');
});

test('loadStorePackageConfig exposes the AppX capabilities required by Hagicode Desktop', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  assert.deepEqual(storePackageConfig.appx?.capabilities, [
    'runFullTrust',
    'internetClient',
    'internetClientServer',
    'privateNetworkClientServer'
  ]);
  assert.equal(storePackageConfig.signing.skipFinalAppxSigning, false);
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
    /Missing Store signing configuration: AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET/
  );
});

test('resolveStoreSigningConfig only requires Azure authentication environment variables', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  const signingConfig = resolveStoreSigningConfig({
    storePackageConfig,
    signingMode: 'required',
    env: {
      AZURE_CODESIGN_APPX_PUBLISHER: 'CN=8B6C8A94-AAE5-4C8B-9202-A29EA42B042F',
      AZURE_CLIENT_ID: 'client-id',
      AZURE_TENANT_ID: 'tenant-id',
      AZURE_CLIENT_SECRET: 'client-secret',
      AZURE_CODESIGN_ENDPOINT: 'https://example.test',
      AZURE_CODESIGN_ACCOUNT_NAME: 'account-name',
      AZURE_CODESIGN_CERTIFICATE_PROFILE_NAME: 'profile-name'
    }
  });

  assert.equal(signingConfig.publisher, storePackageConfig.signing.publisherSubject);
  assert.equal(signingConfig.publisherName, 'CN=8B6C8A94-AAE5-4C8B-9202-A29EA42B042F');
  assert.equal(signingConfig.azure.endpoint, 'https://example.test');
  assert.equal(signingConfig.azure.codeSigningAccountName, 'account-name');
  assert.equal(signingConfig.azure.certificateProfileName, 'profile-name');
});

test('resolveStoreSigningConfig prefers AZURE_CODESIGN_APPX_PUBLISHER for the AppX publisher subject', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  const signingConfig = resolveStoreSigningConfig({
    storePackageConfig,
    signingMode: 'required',
    env: {
      AZURE_CODESIGN_APPX_PUBLISHER: 'CN=Hagicode Publisher, O=HagiCode, C=US',
      AZURE_CLIENT_ID: 'client-id',
      AZURE_TENANT_ID: 'tenant-id',
      AZURE_CLIENT_SECRET: 'client-secret',
      AZURE_CODESIGN_ENDPOINT: 'https://example.test',
      AZURE_CODESIGN_ACCOUNT_NAME: 'account-name',
      AZURE_CODESIGN_CERTIFICATE_PROFILE_NAME: 'profile-name'
    }
  });

  assert.equal(signingConfig.publisher, 'CN=Hagicode Publisher, O=HagiCode, C=US');
  assert.equal(signingConfig.publisherName, 'CN=Hagicode Publisher, O=HagiCode, C=US');
});

test('resolveStoreSigningConfig reports missing Azure Trusted Signing options separately from auth envs', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  assert.throws(
    () =>
      resolveStoreSigningConfig({
        storePackageConfig,
        signingMode: 'required',
        env: {
          AZURE_CLIENT_ID: 'client-id',
          AZURE_TENANT_ID: 'tenant-id',
          AZURE_CLIENT_SECRET: 'client-secret'
        }
      }),
    /Missing Azure Trusted Signing options: endpoint, codeSigningAccountName, certificateProfileName/
  );
});

test('resolveStoreSigningConfig rejects a publisher that is not a valid distinguished name', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  const invalidPublisherConfig = {
    ...storePackageConfig,
    signing: {
      ...storePackageConfig.signing,
      publisherSubject: 'not-a-distinguished-name'
    }
  };

  assert.throws(
    () =>
      resolveStoreSigningConfig({
        storePackageConfig: invalidPublisherConfig,
        signingMode: 'required',
        env: {
          AZURE_CLIENT_ID: 'client-id',
          AZURE_TENANT_ID: 'tenant-id',
          AZURE_CLIENT_SECRET: 'client-secret'
        }
      }),
    /Invalid Store signing publisher/
  );
});

test('resolveStoreSigningConfig supports external signing mode without Azure auth inputs', async () => {
  const storePackageConfig = await loadStorePackageConfig();
  const signingConfig = resolveStoreSigningConfig({
    storePackageConfig,
    signingMode: 'external',
    env: {
      AZURE_CODESIGN_APPX_PUBLISHER: 'CN=Hagicode Publisher, O=HagiCode, C=US'
    }
  });

  assert.equal(signingConfig.mode, 'external');
  assert.equal(signingConfig.enabled, true);
  assert.equal(signingConfig.external, true);
  assert.equal(signingConfig.inlineAzureTrustedSigning, false);
  assert.equal(signingConfig.publisher, 'CN=Hagicode Publisher, O=HagiCode, C=US');
});
