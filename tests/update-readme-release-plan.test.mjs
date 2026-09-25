import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { updateReadmeReleasePlan } from '../scripts/update-readme-release-plan.mjs';
import { WIN_STORE_PACKER_HANDOFF_SCHEMA } from '../scripts/lib/build-plan.mjs';

const start = '<!-- release-plan-history:start -->';
const end = '<!-- release-plan-history:end -->';
const initialHistory = '{"schemaVersion":1,"records":{}}\n';
const initialReadme = `Before\n${start}\nold table\n${end}\nAfter\n`;

function plan(tag, generatedAt = '2026-09-25T00:00:00.000Z') {
  const asset = { name: 'package.zip', path: 'package.zip' };
  return {
    generatedAt,
    release: { repository: 'HagiCode-org/win_store_packer', tag },
    handoff: {
      schema: WIN_STORE_PACKER_HANDOFF_SCHEMA,
      producer: { repository: 'HagiCode-org/win_store_packer', workflow: 'package-release' },
      consumer: { repository: 'HagiCode-org/win_store_packer', workflow: 'package-release' },
      assetName: 'release-plan.json', source: 'workflow-artifact'
    },
    upstream: {
      desktop: {
        sourceMode: 'main', tag: 'v1', version: 'v1', baseVersion: 'v1',
        baseTag: 'v1', checkoutRef: 'main', checkoutType: 'branch'
      },
      server: { version: 'v2', assetsByPlatform: { 'win-x64': asset } },
      dlcs: { 'turbo-engine': {
        version: 'v3', dlcId: 'pcode.turbo-engine', directoryId: 'turbo-engine',
        assetsByPlatform: { 'win-x64': asset }
      } }
    },
    store: {
      supportedWindowsTargets: ['win-x64'],
      desktop: { storeConfigPath: 'config.json', buildCommand: 'build', runtimeInjectionPath: 'runtime' },
      dlcs: { 'turbo-engine': {
        directoryId: 'turbo-engine', dlcId: 'pcode.turbo-engine', sourceName: 'turbo-engine',
        runtimeTargetPath: 'runtime', runtimeIndexPath: 'index.json',
        manifestFileName: 'manifest.json', filesManifestFileName: 'files.json'
      } }
    },
    platforms: ['win-x64'],
    downloads: { desktop: {}, server: {}, dlc: {} },
    publication: { mode: 'github-release' },
    build: { shouldBuild: true, forceRebuild: false, dryRun: false }
  };
}

async function fixture(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'release-history-'));
  const paths = {
    planPath: path.join(dir, 'plan.json'),
    historyPath: path.join(dir, 'history.json'),
    readmePath: path.join(dir, 'README.md')
  };
  try {
    await writeFile(paths.historyPath, initialHistory);
    await writeFile(paths.readmePath, initialReadme);
    async function update(tag, status = 'unpublished', data = plan(tag)) {
      await writeFile(paths.planPath, JSON.stringify(data));
      return updateReadmeReleasePlan({ ...paths, expectedReleaseTag: tag, status });
    }
    await run({ ...paths, update, readHistory: async () => JSON.parse(await readFile(paths.historyPath, 'utf8')) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('creates records, promotes publication from actual inputs and never downgrades', async () => {
  await fixture(async ({ update, readHistory, readmePath, historyPath }) => {
    assert.deepEqual(await update('v1'), { historyChanged: true, readmeChanged: true });
    const changed = plan('v1', '2026-09-26T00:00:00.000Z');
    changed.upstream.server.version = 'v4';
    await update('v1', 'published', changed);
    assert.equal((await readHistory()).records.v1.plan.serverVersion, 'v4');
    assert.equal((await readHistory()).records.v1.status, 'published');
    const historyBefore = await readFile(historyPath);
    const readmeBefore = await readFile(readmePath);
    const later = plan('v1', '2026-09-27T00:00:00.000Z');
    assert.deepEqual(await update('v1', 'unpublished', later), { historyChanged: false, readmeChanged: false });
    assert.deepEqual(await readFile(historyPath), historyBefore);
    assert.deepEqual(await readFile(readmePath), readmeBefore);
    changed.generatedAt = '2026-09-28T00:00:00.000Z';
    assert.deepEqual(await update('v1', 'published', changed), { historyChanged: false, readmeChanged: false });
  });
});

test('retains all versions while rendering only latest 10 with deterministic tie order and escaping', async () => {
  await fixture(async ({ update, readHistory, readmePath }) => {
    for (let index = 1; index <= 11; index++) {
      const data = plan(`v${index}`, `2026-09-${String(index + 10).padStart(2, '0')}T00:00:00.000Z`);
      if (index === 11) data.upstream.server.version = 'a|b\nnext';
      await update(`v${index}`, 'unpublished', data);
    }
    const readme = await readFile(readmePath, 'utf8');
    assert.equal(Object.keys((await readHistory()).records).length, 11);
    assert.doesNotMatch(readme, /\| v1 \|/);
    assert.match(readme, /\| v11 \| Unpublished \|/);
    assert.match(readme, /a\\\|b next/);
    assert.ok(readme.indexOf('| v11 |') < readme.indexOf('| v10 |'));
    assert.match(readme, /^Before\n/);
    assert.match(readme, /\nAfter\n$/);
    const sameTime = plan('v10', '2026-09-21T00:00:00.000Z');
    sameTime.upstream.server.version = 'new-server';
    await update('v10', 'unpublished', sameTime);
    const tied = await readFile(readmePath, 'utf8');
    assert.ok(tied.indexOf('| v10 |') < tied.indexOf('| v11 |'));
    assert.equal(Object.keys((await readHistory()).records).length, 11);
  });
});

test('repairs stale table presentation without changing stored snapshot time', async () => {
  await fixture(async ({ update, historyPath, readmePath }) => {
    await update('v1');
    const history = await readFile(historyPath);
    await writeFile(readmePath, initialReadme);
    assert.deepEqual(await update('v1', 'unpublished', plan('v1', '2026-09-30T00:00:00.000Z')),
      { historyChanged: false, readmeChanged: true });
    assert.deepEqual(await readFile(historyPath), history);
  });
});

test('rejects malformed history, invalid plans and missing or duplicate markers without changing bytes', async () => {
  await fixture(async ({ update, historyPath, readmePath, planPath }) => {
    const cases = [
      async () => writeFile(historyPath, '{broken'),
      async () => { await writeFile(historyPath, initialHistory); await writeFile(readmePath, 'no markers'); },
      async () => writeFile(readmePath, `${initialReadme}${start}\n${end}`),
      async () => { await writeFile(readmePath, initialReadme); await writeFile(historyPath, '{"schemaVersion":9,"records":{}}'); }
    ];
    for (const corrupt of cases) {
      await corrupt();
      const beforeHistory = await readFile(historyPath);
      const beforeReadme = await readFile(readmePath);
      await assert.rejects(update('v1'));
      assert.deepEqual(await readFile(historyPath), beforeHistory);
      assert.deepEqual(await readFile(readmePath), beforeReadme);
    }
    await writeFile(historyPath, initialHistory);
    await writeFile(readmePath, initialReadme);
    const invalid = plan('v1');
    invalid.upstream.server.version = '';
    await assert.rejects(update('v1', 'unpublished', invalid), /version/);
    assert.equal(await readFile(historyPath, 'utf8'), initialHistory);
    assert.equal(await readFile(readmePath, 'utf8'), initialReadme);
    await assert.rejects(update('v2', 'unpublished', plan('v1')), /tag does not match/);
    assert.ok(await readFile(planPath));
  });
});
