import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export async function createArtifactRecord({ artifactPath, platformId, metadata = {} }) {
  const fileStat = await stat(artifactPath);
  return {
    platform: platformId,
    sourcePath: artifactPath,
    outputPath: artifactPath,
    fileName: path.basename(artifactPath),
    sizeBytes: fileStat.size,
    sha256: await sha256File(artifactPath),
    ...metadata
  };
}
