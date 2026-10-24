'use strict';

// Minimal ZIP writer (store-only, no compression). Used for folder uploads.
// Used to package a folder upload in the browser without dependencies.

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const t = date || new Date();
  const time = ((t.getHours() << 11) | (t.getMinutes() << 5) | Math.floor(t.getSeconds() / 2)) & 0xffff;
  const day = ((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate();
  return { time, day: day & 0xffff };
}

function utf8(str) { return new TextEncoder().encode(str); }

function buildZip(files) {
  // files: [{ name, data: Uint8Array }]
  const { time, day } = dosDateTime();
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(data);
    const size = data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);      // local header sig
    dv.setUint16(4, 20, true);             // version needed
    dv.setUint16(6, 0x0800, true);         // UTF-8 flag
    dv.setUint16(8, 0, true);              // method: store
    dv.setUint16(10, time, true);
    dv.setUint16(12, day, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);      // central header sig
    cv.setUint16(4, 20, true);             // version made by
    cv.setUint16(6, 20, true);             // version needed
    cv.setUint16(8, 0x0800, true);         // UTF-8 flag
    cv.setUint16(10, 0, true);             // method
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);             // extra len
    cv.setUint16(32, 0, true);             // comment len
    cv.setUint16(34, 0, true);             // disk
    cv.setUint16(36, 0, true);             // internal attrs
    cv.setUint32(38, 0, true);             // external attrs
    cv.setUint32(42, offset, true);        // local header offset
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + size;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < files.length; i++) {
    out.set(locals[i], pos); pos += locals[i].length;
    const data = files[i].data instanceof Uint8Array ? files[i].data : new Uint8Array(files[i].data);
    out.set(data, pos); pos += data.length;
  }
  for (const c of centrals) { out.set(c, pos); pos += c.length; }
  out.set(eocd, pos);
  return out;
}


if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildZip, crc32 };
}
