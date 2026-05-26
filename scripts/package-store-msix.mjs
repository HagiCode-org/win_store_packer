#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchive } from './lib/archive.mjs';
import { runCommand } from './lib/command.mjs';

const __filename = fileURLToPath(import.meta.url);
const WINAPPCLI_VERSION = '0.3.1';
const WINDOWS_PACKAGE_PUBLISHER_ENV = 'WINDOWS_PACKAGE_PUBLISHER';
const REQUIRED_APPX_ASSETS = [
  'StoreLogo.png',
  'Square44x44Logo.png',
  'Square150x150Logo.png',
  'Wide310x150Logo.png',
];

function parseArgs(argv) {
  const options = {
    projectRoot: process.cwd(),
    config: 'electron-builder.yml',
    input: 'pkg/win-unpacked',
    output: 'pkg',
    stage: 'build/msix-stage',
    assets: 'resources/appx',
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--project-root':
        options.projectRoot = path.resolve(argv[++index]);
        break;
      case '--config':
        options.config = argv[++index];
        break;
      case '--input':
        options.input = argv[++index];
        break;
      case '--output':
        options.output = argv[++index];
        break;
      case '--stage':
        options.stage = argv[++index];
        break;
      case '--assets':
        options.assets = argv[++index];
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(`Usage: node scripts/package-store-msix.mjs [options]\n\nOptions:\n  --project-root <dir>  Desktop workspace root (default: current directory)\n  --config <path>       Generated electron-builder overlay config (default: electron-builder.yml)\n  --input <dir>         Source unpacked app directory (default: pkg/win-unpacked)\n  --output <dir>        Output directory for the MSIX package (default: pkg)\n  --stage <dir>         Temporary staging directory (default: build/msix-stage)\n  --assets <dir>        AppX/MSIX asset directory (default: resources/appx)\n  --verbose             Print verbose winapp CLI output\n`);
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    ...options,
    configPath: path.resolve(options.projectRoot, options.config),
    inputPath: path.resolve(options.projectRoot, options.input),
    outputPath: path.resolve(options.projectRoot, options.output),
    stagePath: path.resolve(options.projectRoot, options.stage),
    assetsPath: path.resolve(options.projectRoot, options.assets),
  };
}

function parseScalar(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseGeneratedStoreConfig(configText) {
  const result = {
    buildVersion: null,
    appx: {},
  };

  let inAppxBlock = false;
  let currentListKey = null;

  for (const line of configText.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }

    if (!line.startsWith(' ')) {
      inAppxBlock = line.trim() === 'appx:';
      currentListKey = null;
      if (line.startsWith('buildVersion:')) {
        result.buildVersion = parseScalar(line.slice('buildVersion:'.length));
      }
      continue;
    }

    if (!inAppxBlock) {
      continue;
    }

    if (line.startsWith('  ') && !line.startsWith('    ')) {
      const trimmed = line.trim();
      if (trimmed.endsWith(':')) {
        currentListKey = trimmed.slice(0, -1);
        result.appx[currentListKey] = [];
        continue;
      }

      const separatorIndex = trimmed.indexOf(':');
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      result.appx[key] = parseScalar(value);
      currentListKey = null;
      continue;
    }

    if (line.startsWith('    - ') && currentListKey) {
      result.appx[currentListKey].push(parseScalar(line.trim().slice(2)));
    }
  }

  return result;
}

function npxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toWindowsArch(nodeArch) {
  switch (nodeArch) {
    case 'x64':
      return 'x64';
    case 'arm64':
      return 'arm64';
    case 'ia32':
      return 'x86';
    default:
      throw new Error(`Unsupported Windows architecture for MSIX packaging: ${nodeArch}`);
  }
}

function sanitizeArtifactNameSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function resolveWindowsPackagePublisher(defaultPublisher) {
  const override = String(process.env[WINDOWS_PACKAGE_PUBLISHER_ENV] || '').trim();
  if (!override) {
    return defaultPublisher;
  }

  console.log(`[msix] using appx.publisher override from ${WINDOWS_PACKAGE_PUBLISHER_ENV}`);
  return override;
}

function normalizeApplicationId(value) {
  const raw = String(value || '')
    .split('.')
    .map((segment) => segment.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean)
    .map((segment) => (/^[A-Za-z]/.test(segment) ? segment : `H${segment}`));

  if (raw.length === 0) {
    return 'HagicodeDesktop';
  }

  return raw.join('.');
}

function renderCapabilities(capabilities) {
  const tags = [];
  for (const capability of capabilities) {
    if (capability === 'runFullTrust') {
      tags.push(`    <rescap:Capability Name="${escapeXml(capability)}" />`);
      continue;
    }

    tags.push(`    <Capability Name="${escapeXml(capability)}" />`);
  }

  return tags.join('\n');
}

function renderMsixManifest({
  identityName,
  publisher,
  version,
  arch,
  displayName,
  publisherDisplayName,
  description,
  executable,
  applicationId,
  backgroundColor,
  languages,
  capabilities,
  minVersion,
  maxVersionTested,
}) {
  const resourceTags = languages.map((language) => `    <Resource Language="${escapeXml(language)}" />`).join('\n');
  const capabilityTags = renderCapabilities(capabilities);

  return `<?xml version="1.0" encoding="utf-8"?>\n<Package\n  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"\n  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"\n  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"\n  IgnorableNamespaces="uap rescap">\n  <Identity Name="${escapeXml(identityName)}" Publisher="${escapeXml(publisher)}" Version="${escapeXml(version)}" ProcessorArchitecture="${escapeXml(arch)}" />\n  <Properties>\n    <DisplayName>${escapeXml(displayName)}</DisplayName>\n    <PublisherDisplayName>${escapeXml(publisherDisplayName)}</PublisherDisplayName>\n    <Description>${escapeXml(description)}</Description>\n    <Logo>Assets\\StoreLogo.png</Logo>\n  </Properties>\n  <Resources>\n${resourceTags}\n  </Resources>\n  <Dependencies>\n    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="${escapeXml(minVersion)}" MaxVersionTested="${escapeXml(maxVersionTested)}" />\n  </Dependencies>\n  <Capabilities>\n${capabilityTags}\n  </Capabilities>\n  <Applications>\n    <Application Id="${escapeXml(applicationId)}" Executable="${escapeXml(executable)}" EntryPoint="Windows.FullTrustApplication">\n      <uap:VisualElements\n        DisplayName="${escapeXml(displayName)}"\n        Description="${escapeXml(description)}"\n        BackgroundColor="${escapeXml(backgroundColor)}"\n        Square150x150Logo="Assets\\Square150x150Logo.png"\n        Square44x44Logo="Assets\\Square44x44Logo.png">\n        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png" />\n      </uap:VisualElements>\n    </Application>\n  </Applications>\n</Package>\n`;
}

async function ensureRequiredFilesExist(paths) {
  for (const targetPath of paths) {
    try {
      await fsp.access(targetPath, fs.constants.R_OK);
    } catch {
      throw new Error(`Required file or directory is missing: ${targetPath}`);
    }
  }
}

async function resolveExecutableName(inputDir, productName) {
  const preferredPath = path.join(inputDir, `${productName}.exe`);
  if (fs.existsSync(preferredPath)) {
    return path.basename(preferredPath);
  }

  const rootEntries = await fsp.readdir(inputDir, { withFileTypes: true });
  const exeNames = rootEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (exeNames.length === 1) {
    return exeNames[0];
  }

  throw new Error(`Unable to determine the packaged desktop executable in ${inputDir}`);
}

async function copyAssets(sourceAssetsDir, targetAssetsDir) {
  await fsp.mkdir(targetAssetsDir, { recursive: true });
  for (const fileName of REQUIRED_APPX_ASSETS) {
    await fsp.copyFile(path.join(sourceAssetsDir, fileName), path.join(targetAssetsDir, fileName));
  }
}

async function loadProjectMetadata(projectRoot, configPath) {
  const [packageJsonContent, configContent] = await Promise.all([
    fsp.readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    fsp.readFile(configPath, 'utf8'),
  ]);

  return {
    packageJson: JSON.parse(packageJsonContent),
    builderConfig: parseGeneratedStoreConfig(configContent),
  };
}

export async function packageStoreMsix(rawOptions = {}) {
  const options = rawOptions.configPath ? rawOptions : parseArgs([]);

  await ensureRequiredFilesExist([options.inputPath, options.assetsPath, options.configPath]);

  const { packageJson, builderConfig } = await loadProjectMetadata(options.projectRoot, options.configPath);
  const appxConfig = builderConfig.appx || {};
  const productName = packageJson.productName || packageJson.name;
  const executable = await resolveExecutableName(options.inputPath, productName);
  const version = String(builderConfig.buildVersion || packageJson.version || '').trim();
  const arch = toWindowsArch(process.arch);
  const identityName = appxConfig.identityName || packageJson.name;
  const publisher = resolveWindowsPackagePublisher(appxConfig.publisher);

  if (!version) {
    throw new Error('Generated Store overlay is missing buildVersion.');
  }

  if (!publisher) {
    throw new Error('Generated Store overlay is missing appx.publisher.');
  }

  const publisherDisplayName = appxConfig.publisherDisplayName || packageJson.author?.name || 'HagiCode';
  const description = packageJson.description || productName;
  const languages = Array.isArray(appxConfig.languages) && appxConfig.languages.length > 0 ? appxConfig.languages : ['en-US'];
  const capabilitySet = new Set(Array.isArray(appxConfig.capabilities) ? appxConfig.capabilities : []);
  capabilitySet.add('runFullTrust');

  await fsp.rm(options.stagePath, { recursive: true, force: true });
  await fsp.mkdir(options.stagePath, { recursive: true });

  const stageAppDir = path.join(options.stagePath, 'app');
  await fsp.cp(options.inputPath, stageAppDir, { recursive: true });
  const portableFixedTarget = path.join(stageAppDir, 'extra', 'portable-fixed', 'current');
  const portableFixedSource = path.join(options.projectRoot, 'resources', 'portable-fixed', 'current');
  if (fs.existsSync(portableFixedSource)) {
    await fsp.mkdir(path.dirname(portableFixedTarget), { recursive: true });
    await fsp.cp(portableFixedSource, portableFixedTarget, { recursive: true });
  }
  await copyAssets(options.assetsPath, path.join(stageAppDir, 'Assets'));

  const manifestPath = path.join(stageAppDir, 'Package.appxmanifest');
  await fsp.writeFile(
    manifestPath,
    renderMsixManifest({
      identityName,
      publisher,
      version,
      arch,
      displayName: appxConfig.displayName || productName,
      publisherDisplayName,
      description,
      executable,
      applicationId: normalizeApplicationId(identityName),
      backgroundColor: appxConfig.backgroundColor || 'transparent',
      languages,
      capabilities: [...capabilitySet],
      minVersion: appxConfig.minVersion || '10.0.19041.0',
      maxVersionTested: appxConfig.maxVersionTested || appxConfig.minVersion || '10.0.19041.0',
    }),
    'utf8'
  );

  await fsp.mkdir(options.outputPath, { recursive: true });
  const artifactBaseName = sanitizeArtifactNameSegment(productName) || 'hagicode-desktop';
  const msixFileName = `${artifactBaseName}-${version}-${arch}.msix`;
  const artifactPath = path.join(options.outputPath, msixFileName);
  await fsp.rm(artifactPath, { force: true });

  if (process.platform === 'win32') {
    const packageArgs = [
      '--yes',
      `@microsoft/winappcli@${WINAPPCLI_VERSION}`,
      'package',
      stageAppDir,
      '--manifest',
      manifestPath,
      '--output',
      options.outputPath,
      '--name',
      msixFileName,
      '--executable',
      executable,
    ];

    if (options.verbose) {
      packageArgs.push('--verbose');
    }

    await runCommand(npxCommand(), packageArgs, {
      cwd: options.projectRoot,
    });
  } else {
    await createArchive(stageAppDir, artifactPath);
  }

  return {
    artifactPath,
    executable,
    manifestPath,
    stageAppDir,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await packageStoreMsix(options);
  console.log(`[msix] packaged ${path.relative(options.projectRoot, result.artifactPath)}`);
}

if (process.argv[1] === __filename) {
  main().catch((error) => {
    console.error(`[msix] ${error.message}`);
    process.exit(1);
  });
}
