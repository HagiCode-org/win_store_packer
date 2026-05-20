import { mkdir, cp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      shell: false
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

async function main() {
  const cwd = process.cwd();
  const pkgDir = path.join(cwd, 'pkg');
  const stagingDir = path.join(pkgDir, '.fixture-msix');
  const msixPath = path.join(pkgDir, 'fixture-output.msix');
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(path.join(stagingDir, 'extra', 'portable-fixed'), { recursive: true });
  await cp(
    path.join(cwd, 'resources', 'portable-fixed', 'current'),
    path.join(stagingDir, 'extra', 'portable-fixed', 'current'),
    { recursive: true, force: true }
  );
  await writeFile(path.join(stagingDir, 'AppxManifest.xml'), '<Package></Package>\n', 'utf8');
  await mkdir(pkgDir, { recursive: true });
  await rm(msixPath, { force: true });

  if (process.platform === 'win32') {
    await run('powershell.exe', [
      '-NoLogo',
      '-NonInteractive',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName 'System.IO.Compression'",
        "Add-Type -AssemblyName 'System.IO.Compression.FileSystem'",
        `$sourceDirectory = '${stagingDir.replace(/'/g, "''")}'`,
        `$destinationArchive = '${msixPath.replace(/'/g, "''")}'`,
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
    ]);
    return;
  }

  await run('zip', ['-qr', msixPath, '.'], { cwd: stagingDir });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
