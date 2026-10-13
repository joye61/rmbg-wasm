#!/usr/bin/env node
/**
 * Batch background removal / AI coloring / edge enhancement for PNG files.
 *
 *   rmbg-batch <input> <output> [--op remove|colorize|edge] [--recursive]
 *              [--suffix .cutout] [--continue-on-error]
 *
 * <input> may be a single .png file or a directory of .png files.
 * Results are written to <output> as 8-bit RGBA PNGs.
 *
 * Note: this CLI handles PNG only (decoding/encoding is dependency-free). The
 * underlying runtime is CPU-bound and single-process; use the browser entry for
 * multi-threaded inference on cross-origin-isolated pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { removeBackground, colorize, edgeEnhance, dispose } from '../src/node.js';
import { decodePNG, encodePNG } from '../src/png.js';

function parseArgs(argv) {
  const opts = { op: 'remove', recursive: false, suffix: '.cutout', continueOnError: false, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--op') opts.op = argv[++i];
    else if (a === '--recursive' || a === '-r') opts.recursive = true;
    else if (a === '--suffix') opts.suffix = argv[++i];
    else if (a === '--continue-on-error') opts.continueOnError = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

function collect(inputDir, recursive) {
  const out = [];
  for (const entry of fs.readdirSync(inputDir, { withFileTypes: true })) {
    const full = path.join(inputDir, entry.name);
    if (entry.isDirectory()) { if (recursive) out.push(...collect(full, recursive)); }
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) out.push(full);
  }
  return out;
}

const OPS = { remove: removeBackground, colorize, edge: edgeEnhance };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts._.length < 2) {
    console.log('Usage: rmbg-batch <input> <output> [--op remove|colorize|edge] [--recursive] [--suffix .cutout] [--continue-on-error]');
    process.exit(opts.help ? 0 : 1);
  }
  const [input, output] = opts._;
  const op = OPS[opts.op];
  if (!op) { console.error('Unknown --op: ' + opts.op); process.exit(1); }

  const stat = fs.statSync(input);
  const files = stat.isDirectory() ? collect(input, opts.recursive) : [input];
  if (!files.length) { console.error('No .png files found in ' + input); process.exit(1); }
  fs.mkdirSync(output, { recursive: true });

  const started = Date.now();
  let done = 0, failed = 0;
  for (const file of files) {
    try {
      const decoded = decodePNG(fs.readFileSync(file));
      const result = opts.op === 'remove'
        ? await op({ data: decoded.data, width: decoded.width, height: decoded.height })
        : await op({ data: decoded.data, width: decoded.width, height: decoded.height }, undefined);
      const png = encodePNG(result.width, result.height, result.data);
      const name = path.basename(file, path.extname(file)) + opts.suffix + '.png';
      fs.writeFileSync(path.join(output, name), png);
      done++;
      console.log(`[${done + failed}/${files.length}] ${file} -> ${path.join(output, name)} (${result.width}x${result.height})`);
    } catch (error) {
      failed++;
      console.error(`[skip] ${file}: ${error.message}`);
      if (!opts.continueOnError) { dispose(); process.exit(1); }
    }
  }
  dispose();
  console.log(`Done: ${done} processed, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (failed && !opts.continueOnError) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
