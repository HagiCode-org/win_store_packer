import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadStorePackageConfig } from './store-config.mjs';
import { pathExists } from './fs-utils.mjs';

function yamlScalar(value) {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

function renderYamlList(key, values, indent = '    ') {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  return [
    `  ${key}:`,
    ...values.map((value) => `${indent}- ${yamlScalar(value)}`)
  ];
}

function renderAppxBlock(packageIdentity, appx = {}, publisherOverride) {
  const lines = [
    'appx:',
    '  artifactName: ${productName} ${version}.appx',
    `  displayName: ${yamlScalar(packageIdentity.displayName)}`,
    `  publisherDisplayName: ${yamlScalar(packageIdentity.publisherDisplayName)}`,
    `  publisher: ${yamlScalar(publisherOverride ?? packageIdentity.publisher)}`,
    `  identityName: ${yamlScalar(packageIdentity.identityName)}`,
    `  backgroundColor: ${yamlScalar(packageIdentity.backgroundColor)}`,
    ...renderYamlList('languages', packageIdentity.languages),
    `  addAutoLaunchExtension: ${yamlScalar(packageIdentity.addAutoLaunchExtension)}`
  ];

  lines.push(...renderYamlList('capabilities', appx.capabilities));

  if (appx.minVersion) {
    lines.push(`  minVersion: ${yamlScalar(appx.minVersion)}`);
  }

  if (appx.maxVersionTested) {
    lines.push(`  maxVersionTested: ${yamlScalar(appx.maxVersionTested)}`);
  }

  return lines.join('\n');
}

function renderWinBlock(signingConfig) {
  if (!signingConfig?.enabled) {
    return null;
  }

  const missingOptions = [];
  if (!signingConfig.azure.endpoint) {
    missingOptions.push('endpoint');
  }
  if (!signingConfig.azure.certificateProfileName) {
    missingOptions.push('certificateProfileName');
  }
  if (!signingConfig.azure.codeSigningAccountName) {
    missingOptions.push('codeSigningAccountName');
  }

  if (missingOptions.length > 0) {
    throw new Error(
      `Cannot render win.azureSignOptions for a signed Store build because these Azure Trusted Signing values are missing: ${missingOptions.join(', ')}.`
    );
  }

  const azureSignOptionLines = [
    signingConfig.publisherName ? `    publisherName: ${yamlScalar(signingConfig.publisherName)}` : null,
    signingConfig.azure.endpoint ? `    endpoint: ${yamlScalar(signingConfig.azure.endpoint)}` : null,
    signingConfig.azure.certificateProfileName ? `    certificateProfileName: ${yamlScalar(signingConfig.azure.certificateProfileName)}` : null,
    signingConfig.azure.codeSigningAccountName ? `    codeSigningAccountName: ${yamlScalar(signingConfig.azure.codeSigningAccountName)}` : null
  ].filter(Boolean);

  if (azureSignOptionLines.length === 0) {
    return null;
  }

  return [
    'win:',
    '  azureSignOptions:',
    ...azureSignOptionLines
  ].join('\n');
}

function renderStoreOverlayConfig(sourceConfigPath, packageIdentity, appx, { packageVersion, publisherOverride, signingConfig }) {
  const packageJsonVersion = String(packageVersion).split('.').slice(0, 3).join('.');
  return [
    `extends: ${yamlScalar(sourceConfigPath)}`,
    `buildVersion: ${yamlScalar(packageVersion)}`,
    'extraMetadata:',
    `  version: ${yamlScalar(packageJsonVersion)}`,
    renderAppxBlock(packageIdentity, appx, publisherOverride),
    renderWinBlock(signingConfig)
  ]
    .filter(Boolean)
    .join('\n');
}

export async function writeStoreElectronBuilderConfig({
  desktopWorkspace,
  sourceConfigPath,
  outputConfigPath,
  packageVersion,
  publisherOverride,
  signingConfig
}) {
  const config = await loadStorePackageConfig();
  const sourcePath = path.join(desktopWorkspace, sourceConfigPath);
  const outputPath = path.join(desktopWorkspace, outputConfigPath);

  if (!(await pathExists(sourcePath))) {
    throw new Error(`Desktop packaging config ${sourcePath} does not exist.`);
  }

  await writeFile(
    outputPath,
    `${renderStoreOverlayConfig(sourceConfigPath, config.packageIdentity, config.appx, { packageVersion, publisherOverride, signingConfig })}\n`,
    'utf8'
  );
  return {
    config,
    sourcePath,
    outputPath,
    packageVersion,
    publisherOverride: publisherOverride ?? null,
    signingEnabled: Boolean(signingConfig?.enabled)
  };
}
