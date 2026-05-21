#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const config = {
  strictMode: process.env.VERIFY_STRICT === 'true'
};

const SIGNABLE_EXTENSIONS = new Set(['.exe', '.dll', '.appx', '.msix', '.msi']);

function isSignableFile(filePath) {
  return SIGNABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function readCatalogFile(catalogPath) {
  return fs.readFileSync(catalogPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeCandidateFiles(files) {
  const unique = [];
  const seen = new Set();
  for (const filePath of files) {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      continue;
    }
    if (!isSignableFile(resolvedPath)) {
      continue;
    }
    if (!seen.has(resolvedPath)) {
      unique.push(resolvedPath);
      seen.add(resolvedPath);
    }
  }
  return unique;
}

function walkDirectories(rootDirectory, predicate, results = []) {
  if (!fs.existsSync(rootDirectory)) {
    return results;
  }

  const entries = fs.readdirSync(rootDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) {
      walkDirectories(entryPath, predicate, results);
      continue;
    }
    if (predicate(entryPath)) {
      results.push(entryPath);
    }
  }
  return results;
}

function compareWindowsSdkVersions(left, right) {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function findSignToolCandidates({
  env = process.env,
  existsSync = fs.existsSync
} = {}) {
  const candidates = [];
  const seen = new Set();

  function addCandidate(candidatePath) {
    if (!candidatePath) {
      return;
    }
    const resolvedPath = path.resolve(candidatePath);
    if (seen.has(resolvedPath) || !existsSync(resolvedPath)) {
      return;
    }
    seen.add(resolvedPath);
    candidates.push(resolvedPath);
  }

  addCandidate(env.SIGNTOOL_PATH);

  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  for (const baseDirectory of [programFiles, programFilesX86]) {
    addCandidate(path.join(baseDirectory, 'Windows Kits', '10', 'bin', 'x64', 'signtool.exe'));
    addCandidate(path.join(baseDirectory, 'Windows Kits', '8.1', 'bin', 'x64', 'signtool.exe'));

    const binRoot = path.join(baseDirectory, 'Windows Kits', '10', 'bin');
    if (existsSync(binRoot)) {
      const sdkCandidates = walkDirectories(
        binRoot,
        (entryPath) => /[\\/]x64[\\/]signtool\.exe$/i.test(entryPath)
      ).sort((left, right) => {
        const leftVersion = left.match(/Windows Kits[\\/]10[\\/]bin[\\/](.+?)[\\/]x64[\\/]signtool\.exe$/i)?.[1] ?? '';
        const rightVersion = right.match(/Windows Kits[\\/]10[\\/]bin[\\/](.+?)[\\/]x64[\\/]signtool\.exe$/i)?.[1] ?? '';
        return compareWindowsSdkVersions(leftVersion, rightVersion);
      });
      for (const candidate of sdkCandidates) {
        addCandidate(candidate);
      }
    }
  }

  return candidates;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

async function verifyWithSigntool(filePath) {
  const candidates = findSignToolCandidates();
  for (const signToolPath of candidates) {
    const result = await runCommand(signToolPath, ['verify', '/pa', filePath]);
    if (result.code === 0) {
      return {
        signed: true,
        method: 'signtool',
        toolPath: signToolPath,
        stdout: result.stdout,
        stderr: result.stderr
      };
    }
  }

  return {
    signed: false,
    method: 'signtool',
    error: candidates.length === 0 ? 'signtool.exe not found on this Windows runner.' : 'signtool verification failed.'
  };
}

async function verifyWithPowerShell(filePath) {
  const script = [
    `$signature = Get-AuthenticodeSignature -FilePath '${filePath.replace(/'/g, "''")}'`,
    'if ($null -eq $signature) { Write-Output "Unknown"; exit 1 }',
    'Write-Output $signature.Status',
    'if ($signature.Status -eq "Valid") { exit 0 }',
    'exit 1'
  ].join('; ');
  const result = await runCommand('powershell.exe', ['-NoLogo', '-NonInteractive', '-Command', script]);
  return {
    signed: result.code === 0,
    method: 'powershell',
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.code === 0 ? null : result.stdout.trim() || result.stderr.trim() || 'PowerShell signature verification failed.'
  };
}

async function verifySignature(filePath) {
  if (process.platform !== 'win32') {
    return {
      signed: false,
      method: 'unsupported-platform',
      error: 'Full Authenticode verification requires Windows.'
    };
  }

  const signtoolResult = await verifyWithSigntool(filePath);
  if (signtoolResult.signed) {
    return signtoolResult;
  }

  const powerShellResult = await verifyWithPowerShell(filePath);
  if (powerShellResult.signed) {
    return powerShellResult;
  }

  return {
    signed: false,
    method: signtoolResult.error?.includes('not found') ? 'powershell-fallback' : 'signtool',
    error: signtoolResult.error?.includes('not found') ? signtoolResult.error : powerShellResult.error
  };
}

function collectTargetFiles(args) {
  if (args.includes('--catalog')) {
    const index = args.indexOf('--catalog');
    const catalogPath = args[index + 1];
    if (!catalogPath) {
      throw new Error('--catalog requires a file path.');
    }
    return readCatalogFile(catalogPath);
  }

  if (args.length === 0) {
    throw new Error('No file path provided.');
  }

  return [args[0]];
}

export async function main(argv = process.argv.slice(2)) {
  const filesToVerify = normalizeCandidateFiles(collectTargetFiles(argv));
  if (filesToVerify.length === 0) {
    console.warn('No signable files found to verify.');
    return;
  }

  console.log(`Verifying ${filesToVerify.length} file(s)...`);
  const failures = [];
  for (const filePath of filesToVerify) {
    const result = await verifySignature(filePath);
    if (result.signed) {
      console.log(`✓ ${path.basename(filePath)} (${result.method})`);
      continue;
    }
    console.log(`✗ ${path.basename(filePath)} (${result.error ?? 'verification failed'})`);
    failures.push({ filePath, result });
  }

  if (failures.length > 0 && config.strictMode) {
    throw new Error(failures.map((failure) => `${path.basename(failure.filePath)}: ${failure.result.error}`).join('; '));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
