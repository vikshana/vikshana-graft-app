#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

function normalizeLockfile(lockfile) {
  if (!lockfile || typeof lockfile !== 'object' || Array.isArray(lockfile)) {
    throw new Error('package-lock.json must be a JSON object');
  }

  const normalized = JSON.parse(JSON.stringify(lockfile));
  delete normalized.version;

  if (normalized.packages && typeof normalized.packages === 'object' && normalized.packages['']) {
    if (typeof normalized.packages[''] !== 'object' || Array.isArray(normalized.packages[''])) {
      throw new Error('package-lock.json packages[""] must be a JSON object');
    }

    delete normalized.packages[''].version;
  }

  return normalized;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input ?? 'package-lock.json';
  const outputPath = args.output;

  if (!outputPath) {
    throw new Error('Missing --output');
  }

  const rawLockfile = readFileSync(inputPath, 'utf8');

  let parsedLockfile;
  try {
    parsedLockfile = JSON.parse(rawLockfile);
  } catch (error) {
    throw new Error(`Invalid JSON in ${inputPath}: ${error.message}`);
  }

  const normalized = normalizeLockfile(parsedLockfile);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');

  process.stdout.write(`${outputPath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`::error::${error.message}\n`);
  process.exit(1);
}
