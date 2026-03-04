#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import os from 'os';

const root = resolve(new URL('..', import.meta.url).pathname);
const releaseRoot = join(root, 'dist', 'release', 'daemon');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;

const platform = mapPlatform(os.platform());
const arch = mapArch(os.arch());

if (!platform || !arch) {
  throw new Error(`Unsupported host for daemon-rs package: ${os.platform()}/${os.arch()}`);
}

const binaryName = platform === 'windows' ? 'discode-daemon-rs.exe' : 'discode-daemon-rs';
const binaryPath = getArg('--binary') || join(root, 'daemon-rs', 'target', 'release', binaryName);
if (!existsSync(binaryPath)) {
  throw new Error(`Rust daemon binary not found: ${binaryPath}`);
}

const suffix = `${platform}-${arch}`;
const packageName = `@siisee11/discode-daemon-rs-${suffix}`;
const outDir = join(releaseRoot, `discode-daemon-rs-${suffix}`);
const binDir = join(outDir, 'bin');
const outputBinary = join(binDir, basename(binaryPath));

mkdirSync(binDir, { recursive: true });
copyFileSync(binaryPath, outputBinary);
if (platform !== 'windows') {
  chmodSync(outputBinary, 0o755);
}

const publishPackage = {
  name: packageName,
  version,
  os: [platform === 'windows' ? 'win32' : platform],
  cpu: [arch],
  files: ['bin'],
  license: 'MIT',
};
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(publishPackage, null, 2)}\n`, 'utf-8');

const manifestPath = join(releaseRoot, 'manifest.json');
let manifest = { binaries: {} };
if (existsSync(manifestPath)) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.binaries && typeof parsed.binaries === 'object') {
      manifest = parsed;
    }
  } catch {
    manifest = { binaries: {} };
  }
}
manifest.binaries[packageName] = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

console.log(`Packaged ${packageName} -> ${outDir}`);

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || null;
}

function mapPlatform(value) {
  if (value === 'darwin' || value === 'linux' || value === 'win32') {
    return value === 'win32' ? 'windows' : value;
  }
  return null;
}

function mapArch(value) {
  if (value === 'x64' || value === 'arm64') {
    return value;
  }
  return null;
}
