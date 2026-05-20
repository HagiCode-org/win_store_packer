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

function renderAppxBlock(packageIdentity) {
  const languageLines = packageIdentity.languages.map((language) => `    - ${language}`).join('\n');
  return [
    'appx:',
    `  displayName: ${yamlScalar(packageIdentity.displayName)}`,
    `  publisherDisplayName: ${yamlScalar(packageIdentity.publisherDisplayName)}`,
    `  publisher: ${yamlScalar(packageIdentity.publisher)}`,
    `  identityName: ${yamlScalar(packageIdentity.identityName)}`,
    `  backgroundColor: ${yamlScalar(packageIdentity.backgroundColor)}`,
    '  languages:',
    languageLines,
    `  addAutoLaunchExtension: ${yamlScalar(packageIdentity.addAutoLaunchExtension)}`
  ].join('\n');
}

function renderStoreOverlayConfig(sourceConfigPath, packageIdentity) {
  return [
    `extends: ${yamlScalar(sourceConfigPath)}`,
    renderAppxBlock(packageIdentity)
  ].join('\n');
}

export async function writeStoreElectronBuilderConfig({
  desktopWorkspace,
  sourceConfigPath,
  outputConfigPath
}) {
  const config = await loadStorePackageConfig();
  const sourcePath = path.join(desktopWorkspace, sourceConfigPath);
  const outputPath = path.join(desktopWorkspace, outputConfigPath);

  if (!(await pathExists(sourcePath))) {
    throw new Error(`Desktop packaging config ${sourcePath} does not exist.`);
  }

  await writeFile(outputPath, `${renderStoreOverlayConfig(sourceConfigPath, config.packageIdentity)}\n`, 'utf8');
  return {
    config,
    sourcePath,
    outputPath
  };
}
