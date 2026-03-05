#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const root = resolve(new URL('..', import.meta.url).pathname);
const releaseRoot = join(root, 'dist', 'release');

const npmRoot = join(releaseRoot, 'npm');
const npmMeta = join(npmRoot, 'discode');

const dirs = findPackageDirs(releaseRoot)
  .filter((dir) => !dir.startsWith(`${npmRoot}/`))
  .sort((a, b) => a.localeCompare(b));

for (const dir of dirs) {
  console.log(`Packing ${dir}`);
  execSync('npm pack', { cwd: dir, stdio: 'inherit' });
}

if (existsSync(join(npmMeta, 'package.json'))) {
  console.log(`Packing ${npmMeta}`);
  execSync('npm pack', { cwd: npmMeta, stdio: 'inherit' });
}

function findPackageDirs(rootDir) {
  const output = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = readdirSync(current, { withFileTypes: true });
    const hasPackageJson = entries.some((entry) => entry.isFile() && entry.name === 'package.json');
    if (hasPackageJson) {
      output.push(current);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      stack.push(join(current, entry.name));
    }
  }
  return output;
}
