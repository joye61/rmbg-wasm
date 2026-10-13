#!/usr/bin/env node
/**
 * Fast pre-publish sanity check. Wired to `prepublishOnly` so `npm publish`
 * (and `npm run pub`) refuses to ship a broken package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const exists = (rel) => fs.existsSync(path.join(root, rel));

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch (e) {
  problems.push('package.json is not valid JSON: ' + e.message);
}

if (pkg) {
  for (const field of ['name', 'version', 'description', 'license', 'main', 'types']) {
    if (!pkg[field]) problems.push(`package.json is missing "${field}"`);
  }
  if (pkg.private === true) problems.push('package.json has "private": true — not publishable');
  const registry = pkg.publishConfig && pkg.publishConfig.registry;
  if (!registry) problems.push('publishConfig.registry is not set');
  else if (registry.replace(/\/+$/, '') !== 'https://registry.npmjs.org') {
    problems.push(`publishConfig.registry should be https://registry.npmjs.org/ (got ${registry})`);
  }
}

for (const f of ['README.md', 'LICENSE']) {
  if (!exists(f)) problems.push(`required file missing: ${f}`);
}

if (pkg && Array.isArray(pkg.files)) {
  for (const f of pkg.files) if (!exists(f)) problems.push(`"files" entry does not exist: ${f}`);
}

const required = [
  'assets/rmbg.glue.js',
  'assets/rmbg.glue.threaded.js',
  'assets/rmbg.pthread.worker.js',
  'assets/rmbg.wasm',
  'assets/rmbg.simd.wasm',
  'assets/rmbg.threads.wasm',
  'assets/rmbg.simd.threads.wasm',
  'assets/rmbg.model.tf',
  'assets/rmbg.harm.tf',
  'src/index.js',
  'src/node.js',
  'src/worker.js',
  'src/refine.js',
  'src/png.js',
  'src/index.d.ts',
  'bin/rmbg-batch.mjs',
];
for (const f of required) if (!exists(f)) problems.push(`required file missing: ${f}`);

if (problems.length) {
  console.error('prepublish check FAILED:');
  for (const p of problems) console.error('  x ' + p);
  process.exit(1);
}
console.log(`prepublish check ok — ${pkg.name}@${pkg.version} (${required.length + 2} files verified)`);
