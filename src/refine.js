/**
 * Local, dependency-free post-processing for high-quality edges.
 *
 * "HD" here means: the model may run at a working resolution, and the resulting
 * alpha matte is then refined against the *full-resolution* color image with an
 * edge-aware guided filter (He et al., 2010). This is a multi-scale strategy —
 * a coarse semantic matte from the model, sharpened to native edges by the
 * image itself — and needs no server.
 */

/** Bilinear down/up-sample of an RGBA buffer. */
export function resizeRgba(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * yr - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xr - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const o = (y * dw + x) * 4;
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i01 + c] * fx;
        const bot = src[i10 + c] * (1 - fx) + src[i11 + c] * fx;
        out[o + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return out;
}

/** Bilinear resample of a single-channel float map in `0..1`. */
export function resizeFloat01(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * yr - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xr - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const a = src[y0 * sw + x0] * (1 - fx) + src[y0 * sw + x1] * fx;
      const b = src[y1 * sw + x0] * (1 - fx) + src[y1 * sw + x1] * fx;
      out[y * dw + x] = a * (1 - fy) + b * fy;
    }
  }
  return out;
}

/** O(1)-per-pixel box mean via a summed-area table (integral image). */
function boxMean(src, width, height, radius, integral, out) {
  const stride = width + 1;
  for (let x = 0; x <= width; x++) integral[x] = 0;
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const row = (y + 1) * stride;
    const prev = y * stride;
    for (let x = 0; x < width; x++) {
      rowSum += src[y * width + x];
      integral[row + x + 1] = integral[prev + x + 1] + rowSum;
    }
  }
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius) * stride;
    const y1 = (Math.min(height - 1, y + radius) + 1) * stride;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius) + 1;
      const area = (x1 - x0) * (Math.min(height - 1, y + radius) - Math.max(0, y - radius) + 1);
      out[y * width + x] =
        (integral[y1 + x1] - integral[y1 + x0] - integral[y0 + x1] + integral[y0 + x0]) / area;
    }
  }
}

/**
 * Edge-aware refinement of an alpha matte using the color image as guide.
 *
 * @param {Uint8ClampedArray} rgb   RGBA at `width * height`
 * @param {Float32Array} alpha      matte in `0..1`, length `width * height`
 * @param {number} width
 * @param {number} height
 * @param {{radius?:number, eps?:number, strength?:number}} [options]
 * @returns {Float32Array} refined matte in `0..1`
 */
export function guidedFilterAlpha(rgb, alpha, width, height, options = {}) {
  const n = width * height;
  const radius = options.radius != null ? options.radius : Math.max(2, Math.round(Math.min(width, height) / 240));
  const eps = options.eps != null ? options.eps : 1e-4;
  const strength = options.strength != null ? options.strength : 1;

  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  const buf = new Float32Array(n);

  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    ch[0][i] = rgb[i * 4] / 255;
    ch[1][i] = rgb[i * 4 + 1] / 255;
    ch[2][i] = rgb[i * 4 + 2] / 255;
  }

  const meanI = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const meanII = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const meanIP = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const meanP = new Float32Array(n);
  const a = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const b = new Float32Array(n);
  const meanA = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const meanB = new Float32Array(n);

  const box = (src, out) => boxMean(src, width, height, radius, integral, out);

  for (let c = 0; c < 3; c++) box(ch[c], meanI[c]);
  box(alpha, meanP);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) buf[i] = ch[c][i] * ch[c][i];
    box(buf, meanII[c]);
  }
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) buf[i] = ch[c][i] * alpha[i];
    box(buf, meanIP[c]);
  }
  for (let i = 0; i < n; i++) {
    let sumA = 0;
    for (let c = 0; c < 3; c++) {
      const varI = meanII[c][i] - meanI[c][i] * meanI[c][i];
      const cov = meanIP[c][i] - meanI[c][i] * meanP[i];
      const ac = cov / (varI + eps);
      a[c][i] = ac;
      sumA += ac * meanI[c][i];
    }
    b[i] = meanP[i] - sumA;
  }
  for (let c = 0; c < 3; c++) box(a[c], meanA[c]);
  box(b, meanB);

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let q = meanB[i];
    for (let c = 0; c < 3; c++) q += meanA[c][i] * ch[c][i];
    if (q < 0) q = 0; else if (q > 1) q = 1;
    out[i] = alpha[i] + strength * (q - alpha[i]);
  }
  return out;
}
