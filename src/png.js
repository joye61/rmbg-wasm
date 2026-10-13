/**
 * Minimal, dependency-free PNG codec (Node only — uses node:zlib).
 *
 * Supports decoding 8-bit, non-interlaced PNGs of color type 0 (gray),
 * 2 (RGB), 3 (palette), 4 (gray+alpha) and 6 (RGBA), and encoding 8-bit RGBA.
 * Exposed as `rmbg-wasm/png` for consumers that need raw RGBA in/out.
 */
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** @returns {{width:number, height:number, data:Uint8ClampedArray}} RGBA. */
export function decodePNG(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('not a PNG');

  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = (buf[offset] << 24 | buf[offset + 1] << 16 | buf[offset + 2] << 8 | buf[offset + 3]) >>> 0;
    const type = String.fromCharCode(buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7]);
    const start = offset + 8;
    const end = start + length;
    if (type === 'IHDR') {
      width = (buf[start] << 24 | buf[start + 1] << 16 | buf[start + 2] << 8 | buf[start + 3]) >>> 0;
      height = (buf[start + 4] << 24 | buf[start + 5] << 16 | buf[start + 6] << 8 | buf[start + 7]) >>> 0;
      bitDepth = buf[start + 8];
      colorType = buf[start + 9];
      interlace = buf[start + 12];
    } else if (type === 'PLTE') {
      palette = buf.subarray(start, end);
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (bitDepth !== 8) throw new Error('only 8-bit PNGs are supported (got ' + bitDepth + ')');
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported PNG color type ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos++];
      const a = x >= channels ? pixels[rowStart + x - channels] : 0;
      const b = y > 0 ? pixels[rowStart - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[rowStart - stride + x - channels] : 0;
      let value = rawByte;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      pixels[rowStart + x] = value & 0xff;
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    const s = i * channels;
    if (colorType === 0) { const g = pixels[s]; data[o] = data[o + 1] = data[o + 2] = g; data[o + 3] = 255; }
    else if (colorType === 2) { data[o] = pixels[s]; data[o + 1] = pixels[s + 1]; data[o + 2] = pixels[s + 2]; data[o + 3] = 255; }
    else if (colorType === 4) { data[o] = data[o + 1] = data[o + 2] = pixels[s]; data[o + 3] = pixels[s + 1]; }
    else if (colorType === 6) { data[o] = pixels[s]; data[o + 1] = pixels[s + 1]; data[o + 2] = pixels[s + 2]; data[o + 3] = pixels[s + 3]; }
    else { const p = pixels[s] * 3; data[o] = palette[p]; data[o + 1] = palette[p + 1]; data[o + 2] = palette[p + 2]; data[o + 3] = 255; }
  }
  return { width, height, data };
}

/** @returns {Uint8Array} PNG bytes for an 8-bit RGBA image. */
export function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x];
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(body).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}
