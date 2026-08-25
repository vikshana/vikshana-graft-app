#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const RELEASE_METADATA_FILES = [
  '.release-please-manifest.json',
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
];

const STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const CI_FULL_PATTERNS = [
  /^src\//,
  /^pkg\//,
  /^tests\//,
  /^package(?:-lock)?\.json$/,
  /^tsconfig.*\.json$/,
  /^go\.mod$/,
  /^go\.sum$/,
  /^Magefile\.go$/,
  /^\.config\//,
  /^playwright\.config\.ts$/,
  /^jest.*\.(?:js|ts)$/,
  /^eslint\.config\.mjs$/,
  /^\.github\/workflows\//,
  /^scripts\/classify-release-pr\.mjs$/,
  /^scripts\/normalize-lockfile-cache-key\.mjs$/,
  /^docker-compose\.yaml$/,
  /^provisioning\//,
  /^\.release-please-manifest\.json$/,
  /^CHANGELOG\.md$/,
];

const COMPAT_FULL_PATTERNS = [
  /^src\//,
  /^package(?:-lock)?\.json$/,
  /^tsconfig.*\.json$/,
  /^\.config\//,
];

const BUNDLE_FULL_PATTERNS = [
  /^src\//,
  /^package(?:-lock)?\.json$/,
  /^\.config\//,
];

const EMPTY_OUTPUTS = {
  mode: 'full',
  'release-version-only': 'false',
  'release-version': '',
  reason: 'normal-change',
  'changed-files-json': '[]',
  'ci-scope': 'full',
  'compat-scope': 'full',
  'bundle-scope': 'full',
};

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    const value = argv[i + 1];

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    i += 1;
  }

  return args;
}

function writeOutputs(outputs, outputPath) {
  if (!outputPath) {
    return;
  }

  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(outputPath, `${key}=${value}\n`);
  }
}

function runGit(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function readGitFile(sha, filePath) {
  try {
    return runGit(['show', `${sha}:${filePath}`]);
  } catch (error) {
    throw new Error(`Unable to read ${filePath} at ${sha}`);
  }
}

function readJsonAt(sha, filePath) {
  const raw = readGitFile(sha, filePath);

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${filePath} at ${sha} is not valid JSON: ${error.message}`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = sortJson(value[key]);
    }
    return output;
  }

  return value;
}

function deepEqual(left, right) {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function normalizePackageJson(value) {
  const normalized = cloneJson(value);
  delete normalized.version;
  return normalized;
}

function normalizePackageLock(value) {
  const normalized = cloneJson(value);
  delete normalized.version;

  if (
    normalized.packages &&
    typeof normalized.packages === 'object' &&
    normalized.packages[''] &&
    typeof normalized.packages[''] === 'object'
  ) {
    delete normalized.packages[''].version;
  }

  return normalized;
}

function normalizeManifest(value) {
  const normalized = cloneJson(value);
  delete normalized['.'];
  return normalized;
}

function requireVersionString(value, sourceLabel) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${sourceLabel} is missing a valid version string`);
  }

  return value.trim();
}

function requireUnifiedVersion(label, values) {
  const normalized = values.map((value, index) => requireVersionString(value, `${label} version source #${index + 1}`));
  const unique = [...new Set(normalized)];

  if (unique.length !== 1) {
    throw new Error(
      `${label} versions do not agree across package.json, package-lock.json, and .release-please-manifest.json: ${normalized.join(', ')}`
    );
  }

  return unique[0];
}

function parseStableSemver(version) {
  const match = version.match(STABLE_SEMVER_PATTERN);
  if (!match) {
    throw new Error(`Version ${version} is not a stable semver (expected MAJOR.MINOR.PATCH)`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left, right) {
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] > right[i]) {
      return 1;
    }

    if (left[i] < right[i]) {
      return -1;
    }
  }

  return 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getChangedFiles(baseSha, headSha) {
  const output = runGit(['diff', '--name-only', `${baseSha}...${headSha}`]);

  if (!output) {
    return [];
  }

  return output
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isAllWithin(files, allowedFiles) {
  const allowed = new Set(allowedFiles);
  return files.every((filePath) => allowed.has(filePath));
}

function matchesAnyPattern(filePath, patterns) {
  return patterns.some((pattern) => pattern.test(filePath));
}

function toScope(files, patterns) {
  return files.some((filePath) => matchesAnyPattern(filePath, patterns)) ? 'full' : 'noop';
}

function verifyReleaseOnlySemantics(baseSha, headSha) {
  const oldPackage = readJsonAt(baseSha, 'package.json');
  const newPackage = readJsonAt(headSha, 'package.json');

  if (!deepEqual(normalizePackageJson(oldPackage), normalizePackageJson(newPackage))) {
    throw new Error('package.json contains changes beyond the version field');
  }

  const oldLock = readJsonAt(baseSha, 'package-lock.json');
  const newLock = readJsonAt(headSha, 'package-lock.json');

  if (!deepEqual(normalizePackageLock(oldLock), normalizePackageLock(newLock))) {
    throw new Error('package-lock.json contains changes beyond root version fields');
  }

  const oldManifest = readJsonAt(baseSha, '.release-please-manifest.json');
  const newManifest = readJsonAt(headSha, '.release-please-manifest.json');

  if (!deepEqual(normalizeManifest(oldManifest), normalizeManifest(newManifest))) {
    throw new Error('.release-please-manifest.json contains changes beyond the "." version key');
  }

  const oldVersion = requireUnifiedVersion('old', [
    oldPackage.version,
    oldLock.version,
    oldLock.packages?.['']?.version,
    oldManifest['.'],
  ]);

  const newVersion = requireUnifiedVersion('new', [
    newPackage.version,
    newLock.version,
    newLock.packages?.['']?.version,
    newManifest['.'],
  ]);

  const parsedOld = parseStableSemver(oldVersion);
  const parsedNew = parseStableSemver(newVersion);
  if (compareSemver(parsedNew, parsedOld) <= 0) {
    throw new Error(`New version ${newVersion} must be greater than previous version ${oldVersion}`);
  }

  const changelog = readGitFile(headSha, 'CHANGELOG.md');
  const headingPattern = new RegExp(`^## \\[${escapeRegExp(newVersion)}\\]`, 'm');
  if (!headingPattern.test(changelog)) {
    throw new Error(`CHANGELOG.md does not contain heading \"## [${newVersion}]\"`);
  }

  return newVersion;
}

function classify(baseSha, headSha) {
  const changedFiles = getChangedFiles(baseSha, headSha);
  const changedSet = new Set(changedFiles);

  if (changedFiles.length === 0) {
    return {
      mode: 'noop',
      reason: 'no-impact-change',
      releaseVersionOnly: false,
      releaseVersion: '',
      changedFiles,
      ciScope: 'noop',
      compatScope: 'noop',
      bundleScope: 'noop',
    };
  }

  const releaseShapeOnly = isAllWithin(changedFiles, RELEASE_METADATA_FILES);
  const exactReleaseFiles =
    changedSet.size === RELEASE_METADATA_FILES.length &&
    RELEASE_METADATA_FILES.every((filePath) => changedSet.has(filePath));

  if (releaseShapeOnly && !exactReleaseFiles) {
    throw new Error(
      `Release-shaped change set must modify exactly these files: ${RELEASE_METADATA_FILES.join(', ')}. Found: ${changedFiles.join(', ')}`
    );
  }

  if (exactReleaseFiles) {
    const releaseVersion = verifyReleaseOnlySemantics(baseSha, headSha);
    return {
      mode: 'release-fast',
      reason: 'validated-release-version-only',
      releaseVersionOnly: true,
      releaseVersion,
      changedFiles,
      ciScope: 'full',
      compatScope: 'noop',
      bundleScope: 'noop',
    };
  }

  const ciScope = toScope(changedFiles, CI_FULL_PATTERNS);
  const compatScope = toScope(changedFiles, COMPAT_FULL_PATTERNS);
  const bundleScope = toScope(changedFiles, BUNDLE_FULL_PATTERNS);

  const hasAnyFullScope = [ciScope, compatScope, bundleScope].some((scope) => scope === 'full');

  if (!hasAnyFullScope) {
    return {
      mode: 'noop',
      reason: 'no-impact-change',
      releaseVersionOnly: false,
      releaseVersion: '',
      changedFiles,
      ciScope,
      compatScope,
      bundleScope,
    };
  }

  return {
    mode: 'full',
    reason: 'normal-change',
    releaseVersionOnly: false,
    releaseVersion: '',
    changedFiles,
    ciScope,
    compatScope,
    bundleScope,
  };
}

function resolveEventDiff(args) {
  const eventName = args['event-name'] ?? process.env.GITHUB_EVENT_NAME ?? '';
  const explicitBaseSha = args['base-sha'] ?? '';
  const explicitHeadSha = args['head-sha'] ?? '';
  const githubSha = process.env.GITHUB_SHA ?? '';

  if (!eventName) {
    throw new Error('Missing --event-name');
  }

  if (eventName === 'pull_request') {
    if (!explicitBaseSha || !explicitHeadSha) {
      throw new Error('pull_request classification requires --base-sha and --head-sha');
    }

    return {
      eventName,
      baseSha: explicitBaseSha,
      headSha: explicitHeadSha,
    };
  }

  if (eventName === 'merge_group') {
    if (!explicitBaseSha || !explicitHeadSha) {
      throw new Error('merge_group classification requires --base-sha and --head-sha');
    }

    return {
      eventName,
      baseSha: explicitBaseSha,
      headSha: explicitHeadSha,
    };
  }

  if (eventName === 'push') {
    const baseSha = explicitBaseSha;
    const headSha = explicitHeadSha || githubSha;

    if (!baseSha || !headSha) {
      throw new Error('push classification requires base and head SHAs');
    }

    if (baseSha === '0000000000000000000000000000000000000000') {
      return {
        eventName,
        baseSha: '',
        headSha,
      };
    }

    return {
      eventName,
      baseSha,
      headSha,
    };
  }

  if (eventName === 'workflow_dispatch') {
    const baseSha = explicitBaseSha;
    const headSha = explicitHeadSha || githubSha;

    if (!baseSha || !headSha) {
      return {
        eventName,
        baseSha: '',
        headSha,
      };
    }

    return {
      eventName,
      baseSha,
      headSha,
    };
  }

  return {
    eventName,
    baseSha: '',
    headSha: explicitHeadSha || githubSha,
  };
}

function buildOutputs(classification) {
  return {
    mode: classification.mode,
    reason: classification.reason,
    'release-version-only': String(classification.releaseVersionOnly),
    'release-version': classification.releaseVersion,
    'changed-files-json': JSON.stringify(classification.changedFiles),
    'ci-scope': classification.ciScope,
    'compat-scope': classification.compatScope,
    'bundle-scope': classification.bundleScope,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = args.output ?? process.env.GITHUB_OUTPUT;

  const { baseSha, headSha } = resolveEventDiff(args);

  if (!baseSha || !headSha) {
    const outputs = {
      ...EMPTY_OUTPUTS,
      mode: 'full',
      reason: 'non-diffable-event',
    };
    writeOutputs(outputs, outputPath);
    process.stdout.write(`${JSON.stringify(outputs)}\n`);
    return;
  }

  const classification = classify(baseSha, headSha);
  const outputs = buildOutputs(classification);

  writeOutputs(outputs, outputPath);
  process.stdout.write(`${JSON.stringify(outputs)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/classify-release-pr.mjs')) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}

export {
  classify,
  resolveEventDiff,
};
