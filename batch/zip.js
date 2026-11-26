// Minimal store-only ZIP writer. Exports are already-compressed JPEG/PNG/WebP, so deflating
// them again would cost time for nothing; "stored" entries just need a CRC and the directory.
// No ZIP64: one archive must stay under 4 GB / 65535 entries — the caller splits long before that.

let TABLE = null;
function crc32(u8) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipWriter {
  constructor() { this.parts = []; this.dir = []; this.offset = 0; this.count = 0; }
  get size() { return this.offset; }

  add(name, bytes, date = new Date()) {
    const nameU8 = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, day, true);
    local.setUint32(14, crc, true); local.setUint32(18, bytes.length, true); local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameU8.length, true); local.setUint16(28, 0, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true); central.setUint16(12, time, true); central.setUint16(14, day, true);
    central.setUint32(16, crc, true); central.setUint32(20, bytes.length, true); central.setUint32(24, bytes.length, true);
    central.setUint16(28, nameU8.length, true); central.setUint32(42, this.offset, true);
    // Blobs, not raw buffers: the browser may page them to disk, so a long batch does not sit in RAM.
    this.parts.push(new Blob([local.buffer, nameU8, bytes]));
    this.dir.push(central.buffer, nameU8);
    this.offset += 30 + nameU8.length + bytes.length;
    this.dirSize = (this.dirSize || 0) + 46 + nameU8.length;
    this.count++;
  }

  finish() {
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, this.count, true); end.setUint16(10, this.count, true);
    end.setUint32(12, this.dirSize || 0, true); end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.dir, end.buffer], { type: 'application/zip' });
  }
}
