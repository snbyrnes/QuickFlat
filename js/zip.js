/*
 * QuickFlat - minimal ZIP writer (store / no compression).
 *
 * Just enough of the ZIP spec to bundle a handful of text files (CSVs, or the
 * XML parts of an .xlsx) into a valid archive with correct CRC-32s and a
 * central directory. No dependencies. Returns a Uint8Array.
 */
(function (root) {
  'use strict';

  // CRC-32 (IEEE 802.3) with a lazily-built lookup table.
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    return new TextEncoder().encode(String(data));
  }

  /**
   * makeZip([{ name, data }]) -> Uint8Array
   * `data` may be a string (UTF-8 encoded) or a Uint8Array.
   */
  function makeZip(files) {
    var enc = new TextEncoder();
    var parts = [];          // ordered byte chunks
    var central = [];        // central directory records
    var offset = 0;
    // Fixed DOS timestamp (2026-01-01 00:00:00) for reproducible archives.
    var dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

    files.forEach(function (f) {
      var nameBytes = enc.encode(f.name);
      var dataBytes = toBytes(f.data);
      var crc = crc32(dataBytes);
      var size = dataBytes.length;

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);   // local file header signature
      lv.setUint16(4, 20, true);           // version needed
      lv.setUint16(6, 0x0800, true);       // flags: UTF-8 filename
      lv.setUint16(8, 0, true);            // method: store
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);        // compressed size
      lv.setUint32(22, size, true);        // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);           // extra length
      local.set(nameBytes, 30);
      parts.push(local, dataBytes);

      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);   // central dir signature
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, 0x0800, true);       // flags
      cv.setUint16(10, 0, true);           // method
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);           // extra
      cv.setUint16(32, 0, true);           // comment
      cv.setUint16(34, 0, true);           // disk number start
      cv.setUint16(36, 0, true);           // internal attrs
      cv.setUint32(38, 0, true);           // external attrs
      cv.setUint32(42, offset, true);      // local header offset
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + dataBytes.length;
    });

    var cdSize = central.reduce(function (a, c) { return a + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);     // EOCD signature
    ev.setUint16(8, files.length, true);   // entries this disk
    ev.setUint16(10, files.length, true);  // total entries
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);        // central dir offset

    var total = offset + cdSize + eocd.length;
    var out = new Uint8Array(total);
    var pos = 0;
    parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    central.forEach(function (c) { out.set(c, pos); pos += c.length; });
    out.set(eocd, pos);
    return out;
  }

  root.QFZip = { makeZip: makeZip, crc32: crc32 };
})(typeof self !== 'undefined' ? self : this);
