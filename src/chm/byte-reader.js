// CHMate — byte-level reader for the ITSS/ITSF container.
//
// A thin cursor over a Uint8Array. All multi-byte integers in the CHM
// *container* are little-endian, EXCEPT ENCINT values, which are a
// variable-length big-endian encoding (7 bits/byte, high bit = "more").
//
// 64-bit values are read as JS numbers. CHM offsets/lengths comfortably fit
// in the 53-bit safe-integer range; we throw if a value would exceed it
// rather than silently lose precision.

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export class ByteReader {
  /** @param {Uint8Array} bytes */
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = offset;
  }

  get length() {
    return this.bytes.length;
  }

  remaining() {
    return this.bytes.length - this.pos;
  }

  seek(pos) {
    this.pos = pos;
    return this;
  }

  skip(n) {
    this.pos += n;
    return this;
  }

  u8() {
    return this.bytes[this.pos++];
  }

  u16() {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32() {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  // 64-bit unsigned, returned as a JS number (throws if not exactly representable).
  u64() {
    const lo = this.view.getUint32(this.pos, true);
    const hi = this.view.getUint32(this.pos + 4, true);
    this.pos += 8;
    const v = hi * 0x100000000 + lo;
    if (v > MAX_SAFE) {
      throw new RangeError(`64-bit value 0x${hi.toString(16)}${lo.toString(16)} exceeds safe integer range`);
    }
    return v;
  }

  // Read `n` raw bytes as a subarray view (no copy).
  bytesOf(n) {
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  // A GUID is 16 bytes; we render it in the canonical {XXXXXXXX-XXXX-...} form
  // for comparison against the documented CHM GUIDs.
  guid() {
    const b = this.bytesOf(16);
    const hex = (i, len) => {
      let s = '';
      for (let k = len - 1; k >= 0; k--) s += b[i + k].toString(16).padStart(2, '0');
      return s.toUpperCase();
    };
    const tail = Array.from(b.subarray(8, 16), (x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
    return `{${hex(0, 4)}-${hex(4, 2)}-${hex(6, 2)}-${tail.slice(0, 4)}-${tail.slice(4)}}`;
  }

  // ENCINT: variable-length, big-endian, 7 bits per byte, MSB of each byte is
  // the "continue" flag. We accumulate with multiplication to stay precise
  // beyond 32 bits.
  encint() {
    let value = 0;
    let b;
    do {
      b = this.bytes[this.pos++];
      value = value * 128 + (b & 0x7f);
      if (value > MAX_SAFE) throw new RangeError('ENCINT exceeds safe integer range');
    } while (b & 0x80);
    return value;
  }
}

const utf8 = new TextDecoder('utf-8');

/** Decode `len` UTF-8 bytes from `bytes` at `pos`. */
export function utf8Slice(bytes, pos, len) {
  return utf8.decode(bytes.subarray(pos, pos + len));
}
