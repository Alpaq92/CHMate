// CHMate — LZX decompressor.
//
// Ported to JavaScript from mlocati/chm-lib (PHP), used under its MIT license.
//   chm-lib © 2016 Michele Locati — MIT. Its LZX algorithm derives from the
//   CHMPane project (© Rui Shen), reused there under MIT by written permission.
//   The canonical-Huffman `makeSymbolTable` was originally coded by David
//   Tritscher. This JavaScript port keeps that MIT lineage.
//
// LZX is the compression used inside a CHM's MSCompressed section. The stream
// is split into 0x8000-byte output "frames"; each frame's compressed data is
// independently 16-bit aligned (the ResetTable stores one byte offset per
// frame). The decoder state (sliding window, Huffman trees, repeated-offset
// LRU, in-progress block) persists across frames but is reset to a clean slate
// every `resetInterval` frames, which is what makes random access possible.
//
// Bit order: the input is read as 16-bit little-endian words, MSB-first within
// each word.

const MIN_MATCH = 2;
const NUM_CHARS = 256;
const BLOCKTYPE_VERBATIM = 1;
const BLOCKTYPE_ALIGNED = 2;
const BLOCKTYPE_UNCOMPRESSED = 3;
const PRETREE_NUM_ELEMENTS = 20;
const ALIGNED_NUM_ELEMENTS = 8;
const NUM_PRIMARY_LENGTHS = 7;
const NUM_SECONDARY_LENGTHS = 249;
const LENTABLE_SAFETY = 64;
const FRAME_SIZE = 0x8000;

// Position-slot tables (slot -> extra footer bits / base offset).
const EXTRA_BITS = new Uint8Array(51);
for (let i = 0, j = 0; i <= 50; i += 2) {
  EXTRA_BITS[i] = j;
  EXTRA_BITS[i + 1] = j;
  if (i !== 0 && j < 17) j++;
}
const POSITION_BASE = new Int32Array(51);
for (let i = 0, j = 0; i <= 50; i++) {
  POSITION_BASE[i] = j;
  j += 1 << EXTRA_BITS[i];
}

const UNSIGNED_MASK = new Int32Array(17);
for (let n = 0; n <= 16; n++) UNSIGNED_MASK[n] = (1 << n) - 1;

// --- Bit reader: 16-bit little-endian words, consumed MSB-first -------------
//
// One BitReader covers exactly one frame's compressed bytes. A 32-bit
// accumulator is filled from the top; everything is masked to 32 bits.
export class BitReader {
  /** @param {Uint8Array} bytes  this frame's compressed data */
  constructor(bytes) {
    this.bytes = bytes;
    this.length = bytes.length;
    this.position = 0;
    this.buffer = 0; // unsigned 32-bit accumulator
    this.bufferSize = 0; // valid bits currently buffered
  }

  ensure(n) {
    while (this.bufferSize < n) {
      if (this.length - this.position < 2) {
        this.position = this.length;
        break;
      }
      const word = this.bytes[this.position] | (this.bytes[this.position + 1] << 8);
      this.position += 2;
      this.buffer = (this.buffer | (word << (16 - this.bufferSize))) >>> 0;
      this.bufferSize += 16;
    }
    return this.bufferSize;
  }

  /** Peek n (<=16) bits without consuming. */
  peek(n) {
    this.ensure(n);
    return (this.buffer >>> (32 - n)) & UNSIGNED_MASK[n];
  }

  /** Read n (<=16) bits, MSB-first. */
  readLE(n) {
    if (n === 0) return 0;
    const result = this.peek(n);
    this.buffer = (this.buffer << n) >>> 0;
    this.bufferSize -= n;
    return result;
  }

  /** Drop the bit buffer and move the byte cursor by n (may be negative). */
  skip(n) {
    this.buffer = 0;
    this.bufferSize = 0;
    this.position += n;
  }

  readUInt32() {
    const p = this.position;
    const v =
      (this.bytes[p] | (this.bytes[p + 1] << 8) | (this.bytes[p + 2] << 16) | (this.bytes[p + 3] << 24)) >>> 0;
    this.position += 4;
    return v;
  }

  /** Copy `length` raw bytes from the byte stream into `dest` at `offset`. */
  readInto(dest, offset, length) {
    for (let k = 0; k < length; k++) dest[offset + k] = this.bytes[this.position++];
  }
}

// --- Canonical Huffman tree (table-based) -----------------------------------
//
// `makeSymbolTable` builds a fast decode table from code lengths (the David
// Tritscher algorithm): short codes map directly; longer codes are reached by
// walking a small binary tree appended after the direct-mapped region.
class Tree {
  constructor(bits, maxSymbol) {
    this.bits = bits;
    this.maxSymbol = maxSymbol;
    this.symbols = new Int32Array((1 << bits) + (maxSymbol << 1));
    this.lens = new Uint8Array(maxSymbol + LENTABLE_SAFETY);
  }

  clear() {
    this.lens.fill(0);
  }

  makeSymbolTable() {
    const { bits, maxSymbol, lens, symbols } = this;
    let bitNum = 1;
    let pos = 0;
    let tableMask = 1 << bits;
    let bitMask = tableMask >> 1;
    let nextSymbol = bitMask;

    while (bitNum <= bits) {
      for (let symbol = 0; symbol < maxSymbol; symbol++) {
        if (lens[symbol] === bitNum) {
          let leaf = pos;
          pos += bitMask;
          if (pos > tableMask) throw new Error('LZX: symbol table overrun');
          while (leaf < pos) symbols[leaf++] = symbol;
        }
      }
      bitMask >>= 1;
      bitNum++;
    }

    if (pos !== tableMask) {
      for (let i = pos; i < tableMask; i++) symbols[i] = 0;
      pos <<= 16;
      tableMask <<= 16;
      bitMask = 1 << 15;
      while (bitNum <= 16) {
        for (let symbol = 0; symbol < maxSymbol; symbol++) {
          if (lens[symbol] === bitNum) {
            let leaf = pos >>> 16;
            for (let fill = 0; fill < bitNum - bits; fill++) {
              if (symbols[leaf] === 0) {
                const n2 = nextSymbol << 1;
                symbols[n2] = 0;
                symbols[n2 + 1] = 0;
                symbols[leaf] = nextSymbol++;
              }
              leaf = symbols[leaf] << 1;
              if (((pos >>> (15 - fill)) & 1) !== 0) leaf++;
            }
            symbols[leaf] = symbol;
            pos += bitMask;
            if (pos > tableMask) throw new Error('LZX: symbol table overflow');
          }
        }
        bitMask >>= 1;
        bitNum++;
      }
    }

    if (pos !== tableMask) {
      for (let sym = 0; sym < maxSymbol; sym++) {
        if (lens[sym] !== 0) throw new Error('LZX: erroneous symbol table');
      }
    }
  }

  readAlignLengthTable(reader) {
    for (let i = 0; i < this.maxSymbol; i++) this.lens[i] = reader.readLE(3);
  }

  // Read delta-coded code lengths for symbols [first, last) using a pretree.
  readLengthTable(reader, first, last) {
    const preTree = new Tree(6, PRETREE_NUM_ELEMENTS);
    for (let i = 0; i < PRETREE_NUM_ELEMENTS; i++) preTree.lens[i] = reader.readLE(4);
    preTree.makeSymbolTable();

    const lens = this.lens;
    let pos = first;
    while (pos < last) {
      const symbol = preTree.readHuffmanSymbol(reader);
      if (symbol === 17) {
        let stop = pos + reader.readLE(4) + 4;
        while (pos < stop) lens[pos++] = 0;
      } else if (symbol === 18) {
        let stop = pos + reader.readLE(5) + 20;
        while (pos < stop) lens[pos++] = 0;
      } else if (symbol === 19) {
        let stop = pos + reader.readLE(1) + 4;
        let value = lens[pos] - preTree.readHuffmanSymbol(reader);
        if (value < 0) value += 17;
        while (pos < stop) lens[pos++] = value;
      } else {
        let value = lens[pos] - symbol;
        if (value < 0) value += 17;
        lens[pos++] = value;
      }
    }
  }

  readHuffmanSymbol(reader) {
    const next = reader.peek(16);
    let symbol = this.symbols[reader.peek(this.bits)];
    if (symbol >= this.maxSymbol) {
      let j = 1 << (16 - this.bits);
      do {
        j >>= 1;
        symbol <<= 1;
        symbol |= (next & j) > 0 ? 1 : 0;
        symbol = this.symbols[symbol];
      } while (symbol >= this.maxSymbol);
    }
    reader.readLE(this.lens[symbol]);
    return symbol;
  }

  isIntel() {
    return this.lens[0xe8] !== 0;
  }
}

// --- LZX inflater -----------------------------------------------------------
//
// Decodes one frame per `inflate()` call into a sliding ring window. State is
// preserved between calls so frames within a reset interval chain together;
// pass reset=true on the first frame of each reset interval.
export class LzxInflater {
  /** @param {number} windowSize  window size in bytes (0x8000..0x200000) */
  constructor(windowSize) {
    if (windowSize < 0x8000 || windowSize > 0x200000) {
      throw new Error(`LZX: unsupported window size ${windowSize}`);
    }
    this.windowSize = windowSize;
    this.window = new Uint8Array(windowSize);
    this.mainTree = new Tree(12, NUM_CHARS + 50 * 8);
    this.lengthTree = new Tree(12, NUM_SECONDARY_LENGTHS + 1);
    this.alignedTree = new Tree(7, ALIGNED_NUM_ELEMENTS);
    this.intelFilesize = 0;

    // Number of position slots from the window size.
    let slots = 0;
    let w = windowSize;
    while (w > 1) {
      w >>= 1;
      slots += 2;
    }
    if (slots === 40) slots = 42;
    else if (slots === 42) slots = 50;
    this.mainElements = NUM_CHARS + (slots << 3);

    this.windowPosition = 0;
    this.r0 = this.r1 = this.r2 = 1;
    this.headerRead = false;
    this.framesRead = 0;
    this.remainingInBlock = 0;
    this.blockType = 0;
    this.blockLength = 0;
    this.intelStarted = false;
    this.intelCurrentPosition = 0;
  }

  /**
   * Decode `numberOfBytes` (one frame) from `reader`.
   * @param {boolean} reset   reset LZX state (first frame of a reset interval)
   * @param {BitReader} reader  this frame's compressed bytes
   * @param {number} numberOfBytes  decoded bytes to produce (<= window size)
   * @returns {Uint8Array}     the decoded frame
   */
  inflate(reset, reader, numberOfBytes) {
    const window = this.window;
    const windowSize = this.windowSize;

    if (reset) {
      this.r0 = this.r1 = this.r2 = 1;
      this.headerRead = false;
      this.framesRead = 0;
      this.remainingInBlock = 0;
      this.blockType = 0;
      this.intelCurrentPosition = 0;
      this.intelStarted = false;
      this.windowPosition = 0;
      this.mainTree.clear();
      this.lengthTree.clear();
    }

    if (!this.headerRead) {
      if (reader.readLE(1) > 0) {
        this.intelFilesize = ((reader.readLE(16) << 16) | reader.readLE(16)) >>> 0;
      }
      this.headerRead = true;
    }

    let togo = numberOfBytes;
    while (togo > 0) {
      if (this.remainingInBlock === 0) {
        if (this.blockType === BLOCKTYPE_UNCOMPRESSED && (this.blockLength & 1) !== 0) {
          reader.skip(1);
        }
        this.blockType = reader.readLE(3);
        this.remainingInBlock = this.blockLength = (reader.readLE(16) << 8) | reader.readLE(8);
        switch (this.blockType) {
          case BLOCKTYPE_ALIGNED:
            this.alignedTree.readAlignLengthTable(reader);
            this.alignedTree.makeSymbolTable();
          // fall through
          case BLOCKTYPE_VERBATIM:
            this.mainTree.readLengthTable(reader, 0, NUM_CHARS);
            this.mainTree.readLengthTable(reader, NUM_CHARS, this.mainElements);
            this.mainTree.makeSymbolTable();
            if (this.mainTree.isIntel()) this.intelStarted = true;
            this.lengthTree.readLengthTable(reader, 0, NUM_SECONDARY_LENGTHS);
            this.lengthTree.makeSymbolTable();
            break;
          case BLOCKTYPE_UNCOMPRESSED:
            this.intelStarted = true;
            if (reader.ensure(16) > 16) reader.skip(-2);
            this.r0 = reader.readUInt32();
            this.r1 = reader.readUInt32();
            this.r2 = reader.readUInt32();
            break;
          default:
            throw new Error(`LZX: unexpected block type ${this.blockType}`);
        }
      }

      let thisRun = this.remainingInBlock;
      if (thisRun > togo) thisRun = togo;
      togo -= thisRun;
      this.remainingInBlock -= thisRun;
      this.windowPosition %= windowSize;
      if (this.windowPosition + thisRun > windowSize) {
        throw new Error('LZX: window overrun');
      }

      if (this.blockType === BLOCKTYPE_UNCOMPRESSED) {
        reader.readInto(window, this.windowPosition, thisRun);
        this.windowPosition += thisRun;
        continue;
      }

      while (thisRun > 0) {
        const mainElement = this.mainTree.readHuffmanSymbol(reader);
        if (mainElement < NUM_CHARS) {
          window[this.windowPosition++] = mainElement;
          thisRun--;
        } else {
          const sym = mainElement - NUM_CHARS;
          let matchLength = sym & NUM_PRIMARY_LENGTHS;
          if (matchLength === NUM_PRIMARY_LENGTHS) {
            matchLength += this.lengthTree.readHuffmanSymbol(reader);
          }
          matchLength += MIN_MATCH;

          let matchOffset = sym >> 3;
          switch (matchOffset) {
            case 0:
              matchOffset = this.r0;
              break;
            case 1:
              matchOffset = this.r1;
              this.r1 = this.r0;
              this.r0 = matchOffset;
              break;
            case 2:
              matchOffset = this.r2;
              this.r2 = this.r0;
              this.r0 = matchOffset;
              break;
            default: {
              if (this.blockType === BLOCKTYPE_VERBATIM) {
                if (matchOffset !== 3) {
                  const extra = EXTRA_BITS[matchOffset];
                  matchOffset = POSITION_BASE[matchOffset] - 2 + reader.readLE(extra);
                } else {
                  matchOffset = 1;
                }
              } else {
                // BLOCKTYPE_ALIGNED
                const extra = EXTRA_BITS[matchOffset];
                matchOffset = POSITION_BASE[matchOffset] - 2;
                if (extra === 0) {
                  matchOffset = 1;
                } else if (extra <= 2) {
                  matchOffset += reader.readLE(extra);
                } else if (extra === 3) {
                  matchOffset += this.alignedTree.readHuffmanSymbol(reader);
                } else {
                  matchOffset += reader.readLE(extra - 3) << 3;
                  matchOffset += this.alignedTree.readHuffmanSymbol(reader);
                }
              }
              this.r2 = this.r1;
              this.r1 = this.r0;
              this.r0 = matchOffset;
              break;
            }
          }

          let runDest = this.windowPosition;
          let runSrc;
          thisRun -= matchLength;
          if (this.windowPosition >= matchOffset) {
            runSrc = runDest - matchOffset; // no wrap
          } else {
            runSrc = runDest + (windowSize - matchOffset); // wrap around
            let copyLength = matchOffset - this.windowPosition;
            if (copyLength < matchLength) {
              matchLength -= copyLength;
              this.windowPosition += copyLength;
              while (copyLength-- > 0) window[runDest++] = window[runSrc++];
              runSrc = 0;
            }
          }
          this.windowPosition += matchLength;
          while (matchLength-- > 0) window[runDest++] = window[runSrc++];
        }
      }
    }

    const start = (this.windowPosition === 0 ? windowSize : this.windowPosition) - numberOfBytes;
    const result = window.slice(start, start + numberOfBytes);

    if (this.intelFilesize !== 0) this._intelDecode(result, numberOfBytes);
    return result;
  }

  // Intel E8 ("call") translation for one frame of output.
  _intelDecode(result, numberOfBytes) {
    if (this.framesRead++ >= 32768) return;
    if (numberOfBytes <= 6 || !this.intelStarted) {
      this.intelCurrentPosition += numberOfBytes;
      return;
    }
    let curpos = this.intelCurrentPosition;
    this.intelCurrentPosition += numberOfBytes;
    const filesize = this.intelFilesize;
    let i = 0;
    while (i < numberOfBytes - 10) {
      if (result[i++] !== 0xe8) {
        curpos++;
        continue;
      }
      const absOff =
        (result[i] | (result[i + 1] << 8) | (result[i + 2] << 16) | (result[i + 3] << 24)) | 0;
      if (absOff >= -curpos && absOff < filesize) {
        const relOff = absOff >= 0 ? absOff - curpos : absOff + filesize;
        result[i] = relOff & 0xff;
        result[i + 1] = (relOff >> 8) & 0xff;
        result[i + 2] = (relOff >> 16) & 0xff;
        result[i + 3] = (relOff >> 24) & 0xff;
      }
      i += 4;
      curpos += 5;
    }
  }
}

/**
 * Decode an entire MSCompressed LZX stream.
 *
 * @param {Uint8Array} input        backing array containing the Content blob
 * @param {number} contentStart     byte offset of the LZX stream within `input`
 * @param {number} compressedLength total compressed length
 * @param {number[]} addressTable    per-frame compressed offsets (rel. contentStart)
 * @param {number} resetInterval    frames between LZX state resets
 * @param {number} uncompressedLength  total decompressed length
 * @param {number} blockSize        output bytes per frame (0x8000)
 * @param {number} windowSize       window size in bytes
 * @returns {Uint8Array}
 */
export function decompressStream(
  input,
  contentStart,
  compressedLength,
  addressTable,
  resetInterval,
  uncompressedLength,
  blockSize,
  windowSize,
) {
  const out = new Uint8Array(uncompressedLength);
  const inflater = new LzxInflater(windowSize);
  const frames = addressTable.length;
  let written = 0;
  for (let frame = 0; frame < frames && written < uncompressedLength; frame++) {
    const inStart = contentStart + addressTable[frame];
    const inEnd = frame + 1 < frames ? contentStart + addressTable[frame + 1] : contentStart + compressedLength;
    const reader = new BitReader(input.subarray(inStart, inEnd));
    const nBytes = Math.min(blockSize, uncompressedLength - written);
    const decoded = inflater.inflate(frame % resetInterval === 0, reader, nBytes);
    out.set(nBytes === decoded.length ? decoded : decoded.subarray(0, nBytes), written);
    written += nBytes;
  }
  return out;
}

export { FRAME_SIZE };
