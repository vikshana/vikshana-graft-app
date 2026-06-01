#!/usr/bin/env node
/**
 * Increment ElectraMet deploy build number (and sync package.json version).
 * Run once before each production deploy: npm run bump:deploy
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const metaPath = path.join(root, 'electramet-build.json');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
meta.build = Number(meta.build || 0) + 1;
const fullVersion = `${meta.version}.${meta.build}`;

fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = fullVersion;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = fullVersion;
  if (lock.packages?.['']) {
    lock.packages[''].version = fullVersion;
  }
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

console.log(`Deploy build bumped: ${fullVersion} (badge: ${meta.version} · build ${meta.build})`);
