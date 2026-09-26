import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDesktopBuildMetadata } from '../scripts/build-msix.mjs';

const requiredFiles = [
  'components/node/runtime/node.exe',
  'npm-pm2/node_modules/pm2/bin/pm2',
  'npm-pm2/node_modules/pm2/package.json',
  'npm-pm2/node_modules/@pm2/io/package.json',
];

function buildMetadata({ buildMode = 'desktop-store-build-command', pm2Toolchain = {} } = {}) {
  return {
    buildMode,
    desktopVersion: '1.0.0',
    desktopSourceRef: 'refs/heads/main',
    storePackageVersion: '1.0.0.0',
    storeConfigPath: 'config/store-package.json',
    overlayConfigPath: 'forge.store-config.json',
    effectiveRuntimeInjectionPath: 'resources/portable-fixed/current',
    artifacts: [{ path: 'pkg/Hagicode.msix', fileName: 'Hagicode.msix', type: 'msix' }],
    primaryArtifactPath: 'pkg/Hagicode.msix',
    store: {},
    pm2Toolchain,
  };
}

test('requires successful Node, PM2, and production dependency validation from Desktop', () => {
  const result = validateDesktopBuildMetadata(buildMetadata({
    pm2Toolchain: {
      validationPassed: true,
      validationStatus: 'validated-staged-and-packaged',
      nodeExecutable: 'components/node/runtime/node.exe',
      pm2Entrypoint: 'npm-pm2/node_modules/pm2/bin/pm2',
      pm2Version: '7.0.1',
      requiredFiles,
    },
  }), { desktopWorkspace: '/tmp/desktop' });

  assert.equal(result.pm2Toolchain.validationPassed, true);
  assert.equal(result.pm2Toolchain.artifactContentsValidated, true);
});

test('rejects real build metadata when Node or PM2 package files are missing', () => {
  const validToolchain = {
    validationPassed: true,
    validationStatus: 'validated-staged-and-packaged',
    nodeExecutable: 'components/node/runtime/node.exe',
    pm2Entrypoint: 'npm-pm2/node_modules/pm2/bin/pm2',
    requiredFiles,
  };
  assert.throws(() => validateDesktopBuildMetadata(buildMetadata({
    pm2Toolchain: {
      ...validToolchain,
      requiredFiles: requiredFiles.filter((file) => file !== 'components/node/runtime/node.exe'),
    },
  }), { desktopWorkspace: '/tmp/desktop' }), /node\.exe/);
  assert.throws(() => validateDesktopBuildMetadata(buildMetadata({
    pm2Toolchain: {
      ...validToolchain,
      requiredFiles: requiredFiles.filter((file) => file !== 'npm-pm2\/node_modules\/pm2\/bin\/pm2'),
    },
  }), { desktopWorkspace: '/tmp/desktop' }), /pm2\/bin\/pm2/);
  assert.throws(() => validateDesktopBuildMetadata(buildMetadata({
    pm2Toolchain: {
      ...validToolchain,
      requiredFiles: requiredFiles.slice(0, 3),
    },
  }), { desktopWorkspace: '/tmp/desktop' }), /production dependency/);
});

test('marks synthetic dry-run metadata as non-validating and rejects content-validation claims', () => {
  const dryRunMetadata = buildMetadata({
    buildMode: 'desktop-store-build-dry-run',
    pm2Toolchain: {
      validationPassed: false,
      validationStatus: 'not-validated-synthetic',
      requiredFiles: [],
    },
  });
  const result = validateDesktopBuildMetadata(dryRunMetadata, { desktopWorkspace: '/tmp/desktop' });
  assert.equal(result.pm2Toolchain.validationPassed, false);
  assert.equal(result.pm2Toolchain.artifactContentsValidated, false);

  assert.throws(() => validateDesktopBuildMetadata(buildMetadata({
    buildMode: 'desktop-store-build-dry-run',
    pm2Toolchain: {
      validationPassed: true,
      validationStatus: 'validated-staged-and-packaged',
      requiredFiles,
    },
  }), { desktopWorkspace: '/tmp/desktop' }), /must not claim PM2 toolchain artifact validation/);
});
