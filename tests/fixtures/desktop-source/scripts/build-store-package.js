import path from 'node:path';
import { mkdir, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    artifactOutputDir: null,
    dryRun: false,
    metadataOutputPath: null,
    overlayOutputPath: null,
    platformId: 'win-x64',
    runtimeInjectionPath: null,
    serverPayloadPath: null,
    storeConfigPath: path.join(projectRoot, 'config', 'store-package.json'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--artifact-output-dir':
        options.artifactOutputDir = path.resolve(argv[++index]);
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--metadata-output-path':
        options.metadataOutputPath = path.resolve(argv[++index]);
        break;
      case '--overlay-output-path':
        options.overlayOutputPath = path.resolve(argv[++index]);
        break;
      case '--platform-id':
        options.platformId = String(argv[++index] ?? options.platformId);
        break;
      case '--runtime-injection-path':
        options.runtimeInjectionPath = path.resolve(argv[++index]);
        break;
      case '--server-payload-path':
        options.serverPayloadPath = path.resolve(argv[++index]);
        break;
      case '--store-config-path':
        options.storeConfigPath = path.resolve(argv[++index]);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed: ${command} ${args.join(' ')}`));
    });
  });
}

async function createArchive(sourceDirectory, destinationArchive) {
  if (process.platform === 'win32') {
    await run('powershell.exe', [
      '-NoLogo',
      '-NonInteractive',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName 'System.IO.Compression'",
        "Add-Type -AssemblyName 'System.IO.Compression.FileSystem'",
        `$sourceDirectory = '${sourceDirectory.replace(/'/g, "''")}'`,
        `$destinationArchive = '${destinationArchive.replace(/'/g, "''")}'`,
        '$sourceRoot = [System.IO.Path]::GetFullPath($sourceDirectory)',
        "if (-not $sourceRoot.EndsWith([System.IO.Path]::DirectorySeparatorChar.ToString()) -and -not $sourceRoot.EndsWith([System.IO.Path]::AltDirectorySeparatorChar.ToString())) { $sourceRoot += [System.IO.Path]::DirectorySeparatorChar }",
        '$archiveStream = [System.IO.File]::Open($destinationArchive, [System.IO.FileMode]::Create)',
        'try {',
        '  $archive = New-Object System.IO.Compression.ZipArchive($archiveStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)',
        '  try {',
        '    Get-ChildItem -LiteralPath $sourceDirectory -Force -Recurse | Sort-Object FullName | ForEach-Object {',
        '      $relativePath = $_.FullName.Substring($sourceRoot.Length).Replace([char]92, [char]47)',
        '      if ([string]::IsNullOrEmpty($relativePath)) { return }',
        '      if ($_.PSIsContainer) {',
        "        if (-not $relativePath.EndsWith('/')) { $relativePath += '/' }",
        '        [void]$archive.CreateEntry($relativePath)',
        '        return',
        '      }',
        '      $entry = $archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)',
        '      $entryStream = $entry.Open()',
        '      try {',
        '        $inputStream = [System.IO.File]::OpenRead($_.FullName)',
        '        try { $inputStream.CopyTo($entryStream) } finally { $inputStream.Dispose() }',
        '      } finally { $entryStream.Dispose() }',
        '    }',
        '  } finally { $archive.Dispose() }',
        '} finally { $archiveStream.Dispose() }'
      ].join('; ')
    ], projectRoot);
    return;
  }

  await run('zip', ['-qr', destinationArchive, '.'], sourceDirectory);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const storeConfig = JSON.parse(await readFile(options.storeConfigPath, 'utf8'));
  const artifactOutputDir = options.artifactOutputDir ?? path.join(projectRoot, storeConfig.outputDirectory);
  const metadataOutputPath = options.metadataOutputPath ?? path.join(projectRoot, storeConfig.metadataOutputPath);
  const overlayOutputPath = options.overlayOutputPath ?? path.join(projectRoot, 'electron-builder.store.yml');
  const runtimeInjectionPath = options.runtimeInjectionPath ?? path.join(projectRoot, storeConfig.runtimeInjectionPath);
  const serverPayloadPath = options.serverPayloadPath ?? runtimeInjectionPath;
  const packageVersion = `${packageJson.version}.0`;
  const stagingDirectory = path.join(artifactOutputDir, '.fixture-store-package');
  const artifactPath = path.join(artifactOutputDir, `${packageJson.productName}-${packageJson.version}-${options.platformId}.msix`);

  await mkdir(path.dirname(overlayOutputPath), { recursive: true });
  await writeFile(
    overlayOutputPath,
    [
      'extends: electron-builder.yml',
      `buildVersion: ${packageVersion}`,
      'appx:',
      `  identityName: ${storeConfig.packageIdentity.identityName}`,
      '  capabilities:',
      ...storeConfig.appx.capabilities.map((capability) => `    - ${capability}`),
    ].join('\n') + '\n',
    'utf8'
  );

  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(path.join(stagingDirectory, 'extra', 'portable-fixed'), { recursive: true });
  await cp(serverPayloadPath, path.join(stagingDirectory, 'extra', 'portable-fixed', 'current'), {
    recursive: true,
    force: true,
  });
  await writeFile(
    path.join(stagingDirectory, 'store-package-identity.json'),
    JSON.stringify({ packageIdentity: storeConfig.packageIdentity, packageVersion }, null, 2) + '\n',
    'utf8'
  );

  await mkdir(artifactOutputDir, { recursive: true });
  await rm(artifactPath, { force: true });
  await createArchive(stagingDirectory, artifactPath);

  const metadata = {
    producer: 'desktop-fixture',
    schemaVersion: 1,
    platform: options.platformId,
    buildMode: options.dryRun ? 'desktop-store-build-dry-run' : 'desktop-store-build-command',
    desktopVersion: packageJson.version,
    desktopSourceRef: 'fixture-desktop-ref',
    storePackageVersion: packageVersion,
    storeConfigPath: options.storeConfigPath,
    overlayConfigPath: overlayOutputPath,
    effectiveRuntimeInjectionPath: runtimeInjectionPath,
    serverPayloadPath,
    serverPayloadRoot: serverPayloadPath,
    store: {
      displayName: storeConfig.packageIdentity.displayName,
      publisherDisplayName: storeConfig.packageIdentity.publisherDisplayName,
      publisher: storeConfig.packageIdentity.publisher,
      identityName: storeConfig.packageIdentity.identityName,
      languages: [...storeConfig.packageIdentity.languages],
      capabilities: [...storeConfig.appx.capabilities],
      minVersion: storeConfig.appx.minVersion,
      maxVersionTested: storeConfig.appx.maxVersionTested,
    },
    artifacts: [
      {
        path: artifactPath,
        fileName: path.basename(artifactPath),
        type: 'msix',
      },
    ],
    primaryArtifactPath: artifactPath,
  };

  await mkdir(path.dirname(metadataOutputPath), { recursive: true });
  await writeFile(metadataOutputPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
