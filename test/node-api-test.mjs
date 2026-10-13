import { removeBackground, colorize, harmonize, edgeEnhance, batch, load, dispose, isSupported } from '../src/node.js';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  const started = Date.now();
  try {
    const info = await fn();
    pass++;
    console.log(`  ok   ${name} (${Date.now() - started}ms)${info !== undefined ? ' -> ' + info : ''}`);
  } catch (e) {
    fail++;
    failures.push(name + ': ' + (e && e.message || e));
    console.log(`  FAIL ${name}: ${e && e.message || e}`);
  }
}

function makeImage(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill ? fill[0] : 180; data[i * 4 + 1] = fill ? fill[1] : 150;
    data[i * 4 + 2] = fill ? fill[2] : 120; data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}
const W = 48, H = 48;
const img = makeImage(W, H, [200, 60, 60]);

console.log('rmbg-wasm Node API test');

await t('isSupported()', () => { if (!isSupported()) throw new Error('no'); });
await t('load({harmonization:true}) stages', async () => {
  const info = await load({ harmonization: true });
  if (JSON.stringify(info.stages) !== JSON.stringify(['wasm', 'model', 'harmonization'])) throw new Error(JSON.stringify(info));
  return JSON.stringify(info);
});

let cutout;
await t('removeBackground default -> {data,width,height}', async () => {
  const r = await removeBackground(img);
  if (!r || r.width !== W || r.height !== H || !(r.data instanceof Uint8ClampedArray)) throw new Error('bad shape');
  cutout = r;
  return `${r.width}x${r.height}`;
});
await t('removeBackground output:uint8array', async () => {
  const r = await removeBackground(img, { output: 'uint8array' });
  if (!(r instanceof Uint8Array) || r.length !== W * H * 4) throw new Error('bad');
  return r.length;
});
await t('removeBackground output:arrayBuffer', async () => {
  const r = await removeBackground(img, { output: 'arrayBuffer' });
  if (!(r instanceof ArrayBuffer) || r.byteLength !== W * H * 4) throw new Error('bad');
  return r.byteLength;
});
await t('hd:true refines alpha (differs from default)', async () => {
  const r = await removeBackground(img, { hd: true });
  if (r.width !== W || r.height !== H) throw new Error('bad');
  if (!(r.data instanceof Uint8ClampedArray)) throw new Error('data not Uint8ClampedArray');
  let diff = 0;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] !== cutout.data[i]) diff++;
  if (diff === 0) throw new Error('hd did not change the alpha');
  return 'alpha diff px=' + diff;
});
await t('maxSize + hd options', async () => {
  const r = await removeBackground(img, { maxSize: 32, hd: { radius: 4, eps: 1e-3, strength: 0.5 } });
  if (r.width !== W || r.height !== H) throw new Error('bad');
  return 'ok';
});
await t('typed-array input + width/height', async () => {
  const r = await removeBackground(new Uint8Array(W * H * 4), { width: W, height: H });
  if (r.width !== W) throw new Error('bad');
  return 'ok';
});
await t('colorize(explicit mask)', async () => {
  const r = await colorize(img, cutout);
  if (r.width !== W) throw new Error('bad');
  return 'ok';
});
await t('colorize(auto mask) / harmonize alias', async () => {
  const r = await harmonize(img);
  if (r.width !== W) throw new Error('bad');
  return 'ok';
});
await t('edgeEnhance(explicit mask)', async () => {
  const r = await edgeEnhance(img, cutout);
  if (r.width !== W) throw new Error('bad');
  return 'ok';
});
await t('batch(removeBackground x2, progress)', async () => {
  const seen = [];
  const r = await batch([img, img], { op: 'removeBackground', onProgress: (s) => seen.push(s) });
  if (r.length !== 2 || !r.every((x) => x.ok)) throw new Error('bad results');
  if (!seen.some((s) => s.index === 1 && s.count === 2 && s.op === 'batch')) throw new Error('missing metadata');
  if (seen.filter((s) => s.phase === 'done').length !== 1) throw new Error('done count');
  return 'ok';
});
await t('batch(colorize, {image})', async () => {
  const r = await batch([{ image: img }], { op: 'colorize' });
  if (!r[0].ok) throw new Error(String(r[0].error));
  return 'ok';
});
await t('invalid input rejects', async () => {
  try { await removeBackground(12345); throw new Error('should throw'); }
  catch (e) { if (/Node input must be/.test(e.message)) return 'rejected'; throw e; }
});
await t('mask size mismatch rejects', async () => {
  try { await colorize(img, makeImage(32, 32)); throw new Error('should throw'); }
  catch (e) { if (/must match/.test(e.message)) return 'rejected'; throw e; }
});
await t('missing model rejects', async () => {
  try { await removeBackground(img, { assets: { model: 'C:/no/such/model.tf' } }); throw new Error('should throw'); }
  catch (e) { if (/ENOENT|no such|model/i.test(e.message)) return 'rejected'; throw e; }
});
await t('dispose() then reuse', async () => {
  dispose();
  const r = await removeBackground(img);
  if (r.width !== W) throw new Error('bad');
  return 'reused';
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:', failures); process.exit(1); }
