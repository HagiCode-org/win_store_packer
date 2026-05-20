import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { loadStorePackageConfig } from './store-config.mjs';

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

export async function writeStoreElectronBuilderConfig({
  desktopWorkspace,
  sourceConfigPath,
  outputConfigPath
}) {
  const config = await loadStorePackageConfig();
  const sourcePath = path.join(desktopWorkspace, sourceConfigPath);
  const outputPath = path.join(desktopWorkspace, outputConfigPath);
  const sourceContent = await readFile(sourcePath, 'utf8');
  const replaced = sourceContent.replace(
    /^appx:\n(?:  .*\n|\n)*(?=^(?:mac|linux|directories|files|asar|asarUnpack|publish|afterPack|afterSign|win):)/m,
    `${renderAppxBlock(config.packageIdentity)}\n`
  );

  if (replaced === sourceContent) {
    throw new Error(`Unable to locate the appx block in ${sourcePath}. The desktop packaging contract may have changed.`);
  }

  await writeFile(outputPath, replaced, 'utf8');
  return {
    config,
    sourcePath,
    outputPath
  };
}
