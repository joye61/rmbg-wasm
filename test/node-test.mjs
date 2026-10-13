import { removeBackground, colorize, edgeEnhance, load } from '../src/node.js';

function makeImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const r2 = (w * 0.3) ** 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dx = x - w / 2, dy = y - h / 2;
      if (dx * dx + dy * dy < r2) { data[i] = 220; data[i + 1] = 40; data[i + 2] = 40; }
      else { data[i] = data[i + 1] = data[i + 2] = 255; }
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}
function alphaStats(u8) {
  let opaque = 0, transp = 0, semi = 0;
  for (let i = 3; i < u8.length; i += 4) { const a = u8[i]; if (a === 255) opaque++; else if (a === 0) transp++; else semi++; }
  return { opaque, transp, semi };
}

const t0 = Date.now();
console.log('init', await load(), Date.now() - t0 + 'ms');

const img = makeImage(64, 64);

const t1 = Date.now();
const cutout = await removeBackground(img);
console.log('removeBackground', cutout.width + 'x' + cutout.height, alphaStats(cutout.data), Date.now() - t1 + 'ms');

const t2 = Date.now();
const colored = await colorize(img, cutout);
console.log('colorize', colored.width + 'x' + colored.height, alphaStats(colored.data), Date.now() - t2 + 'ms');

const t3 = Date.now();
const edged = await edgeEnhance(img, cutout);
console.log('edgeEnhance', edged.width + 'x' + edged.height, alphaStats(edged.data), Date.now() - t3 + 'ms');

const auto = await colorize(img); // mask computed automatically
console.log('colorize(auto-mask)', auto.width + 'x' + auto.height, alphaStats(auto.data));
