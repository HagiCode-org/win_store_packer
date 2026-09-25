#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { normalizeGitTag } from './lib/platforms.mjs';
import { annotateError } from './lib/summary.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const start = '<!-- release-plan-history:start -->';
const end = '<!-- release-plan-history:end -->';
const columns = '| Version | Status | Store version | Desktop / ref | Server | Turbo Engine DLC | Platforms | Snapshot UTC |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
const fields = ['storeVersion', 'desktopVersion', 'desktopRef', 'serverVersion', 'dlcVersion'];

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function timestamp(value, label) {
  text(value, label);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a UTC ISO timestamp.`);
  }
  return value;
}

function validateHistory(history) {
  object(history, 'History');
  if (history.schemaVersion !== 1) throw new Error('Unsupported release plan history schema version.');
  const records = object(history.records, 'History records');
  for (const [tag, record] of Object.entries(records)) {
    if (normalizeGitTag(tag) !== tag || !/^v[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
      throw new Error(`Invalid history tag: ${tag}`);
    }
    object(record, `History record ${tag}`);
    if (record.status !== 'published' && record.status !== 'unpublished') {
      throw new Error(`Invalid history status for ${tag}.`);
    }
    timestamp(record.changedAt, `${tag}.changedAt`);
    const plan = object(record.plan, `${tag}.plan`);
    for (const field of fields) text(plan[field], `${tag}.${field}`);
    if (!Array.isArray(plan.platforms) || !plan.platforms.length ||
        plan.platforms.some((platform) => typeof platform !== 'string' || !platform.trim())) {
      throw new Error(`Invalid history platforms for ${tag}.`);
    }
    if (Object.keys(plan).sort().join(',') !== [...fields, 'platforms'].sort().join(',')) {
      throw new Error(`Unexpected history plan fields for ${tag}.`);
    }
    if (Object.keys(record).sort().join(',') !== 'changedAt,plan,status') {
      throw new Error(`Unexpected history record fields for ${tag}.`);
    }
  }
  if (Object.keys(history).sort().join(',') !== 'records,schemaVersion') {
    throw new Error('Unexpected history fields.');
  }
  return history;
}

function bounds(readme) {
  const first = readme.indexOf(start);
  const last = readme.indexOf(end);
  if (first < 0 || last < first + start.length ||
      readme.indexOf(start, first + start.length) !== -1 ||
      readme.indexOf(end, last + end.length) !== -1) {
    throw new Error('README must contain exactly one ordered release plan history marker pair.');
  }
  return [first, last + end.length];
}

function escapeMarkdown(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');
}

function render(history) {
  const rows = Object.entries(history.records)
    .sort(([leftTag, left], [rightTag, right]) =>
      right.changedAt.localeCompare(left.changedAt) || leftTag.localeCompare(rightTag))
    .slice(0, 10)
    .map(([tag, record]) => {
      const plan = record.plan;
      return `| ${[tag, record.status === 'published' ? 'Published' : 'Unpublished',
        plan.storeVersion, `${plan.desktopVersion} / ${plan.desktopRef}`,
        plan.serverVersion, plan.dlcVersion, plan.platforms.join(', '), record.changedAt]
        .map(escapeMarkdown).join(' | ')} |`;
    });
  return `${start}\n${columns}${rows.length ? `\n${rows.join('\n')}` : ''}\n${end}`;
}

export async function updateReadmeReleasePlan({
  planPath,
  expectedReleaseTag,
  status,
  historyPath = path.join(root, 'config/release-plan-history.json'),
  readmePath = path.join(root, 'README.md')
}) {
  if (!planPath || !expectedReleaseTag || !['published', 'unpublished'].includes(status)) {
    throw new Error('Specify --plan, --expected-release-tag, and --status (published or unpublished).');
  }
  const tag = normalizeGitTag(expectedReleaseTag);
  if (!/^v[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) throw new Error('Invalid release tag.');
  const rawPlan = JSON.parse(await readFile(planPath, 'utf8'));
  if (rawPlan?.release?.tag && normalizeGitTag(rawPlan.release.tag) !== tag) {
    throw new Error('Plan release tag does not match the expected tag.');
  }
  const validated = await loadReleasePlan(planPath, {
    expectedReleaseTag: tag,
    expectedPublicationMode: 'github-release',
    expectedHandoffSource: 'workflow-artifact'
  });
  const plan = validated.plan;
  if (plan.release.tag !== tag || !plan.build.shouldBuild || plan.build.dryRun) {
    throw new Error('Plan must match the expected tag and be a non-dry-run release plan.');
  }
  timestamp(plan.generatedAt, 'plan.generatedAt');
  const [historyBytes, readme] = await Promise.all([
    readFile(historyPath, 'utf8'),
    readFile(readmePath, 'utf8')
  ]);
  const history = validateHistory(JSON.parse(historyBytes));
  const [begin, finish] = bounds(readme);
  const summary = {
    storeVersion: text(plan.release.windowsStoreVersion, 'Store version'),
    desktopVersion: text(plan.upstream.desktop.version, 'Desktop version'),
    desktopRef: text(plan.upstream.desktop.checkoutRef, 'Desktop checkout ref'),
    serverVersion: text(plan.upstream.server.version, 'Server version'),
    dlcVersion: text(plan.upstream.dlcs['turbo-engine']?.version, 'Turbo Engine DLC version'),
    platforms: plan.platforms
  };
  const previous = history.records[tag];
  if (!(previous?.status === 'published' && status === 'unpublished') &&
      (!previous || previous.status !== status || JSON.stringify(previous.plan) !== JSON.stringify(summary))) {
    history.records[tag] = { status, changedAt: plan.generatedAt, plan: summary };
  }
  const nextReadme = readme.slice(0, begin) + render(history) + readme.slice(finish);
  const nextHistory = `${JSON.stringify(history, null, 2)}\n`;
  if (nextHistory !== historyBytes) await writeFile(historyPath, nextHistory, 'utf8');
  if (nextReadme !== readme) await writeFile(readmePath, nextReadme, 'utf8');
  return { historyChanged: nextHistory !== historyBytes, readmeChanged: nextReadme !== readme };
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'expected-release-tag': { type: 'string' },
      status: { type: 'string' },
      history: { type: 'string' },
      readme: { type: 'string' }
    }
  });
  updateReadmeReleasePlan({
    planPath: values.plan,
    expectedReleaseTag: values['expected-release-tag'],
    status: values.status,
    historyPath: values.history,
    readmePath: values.readme
  }).catch((error) => {
    annotateError(error.message);
    console.error(error);
    process.exitCode = 1;
  });
}
