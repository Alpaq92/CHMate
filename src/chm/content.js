// CHMate — content resolution: path -> bytes.
//
// Uncompressed entries are a raw slice of the file. Compressed (section 1)
// entries live inside one big LZX stream that resets every `resetInterval`
// frames; the ResetTable records the compressed offset of every frame so we
// can decode just the reset block(s) covering the requested byte range.
//
// Decoded reset blocks are cached (LRU) so that a topic and all its images,
// which cluster in the same reset block, decompress that block only once.

import { ByteReader } from './byte-reader.js';
import { decompressStream, FRAME_SIZE } from './lzx.js';

/** Parse the `LZXC` ControlData record. */
function parseControlData(bytes) {
  const r = new ByteReader(bytes);
  r.u32(); // number of DWORDs (6)
  const sig = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  r.skip(4);
  if (sig !== 'LZXC') throw new Error(`Unsupported compression signature ${JSON.stringify(sig)}`);
  const version = r.u32();
  const resetInterval = r.u32(); // in frames
  const windowSizeFrames = r.u32(); // window size in 0x8000-byte frames
  const cacheSize = r.u32();

  const windowSize = windowSizeFrames * FRAME_SIZE;
  return { version, resetInterval, windowSize, cacheSize };
}

/** Parse the LZX ResetTable: per-frame compressed offsets. */
function parseResetTable(bytes) {
  const r = new ByteReader(bytes);
  r.u32(); // version / unknown (2)
  const numEntries = r.u32();
  r.u32(); // entry size (8)
  r.u32(); // table header length (0x28)
  const uncompressedLength = r.u64();
  const compressedLength = r.u64();
  const frameSize = r.u64(); // 0x8000
  const offsets = new Array(numEntries);
  for (let i = 0; i < numEntries; i++) offsets[i] = r.u64();
  return { uncompressedLength, compressedLength, frameSize, offsets };
}

export class ContentResolver {
  /**
   * @param {Uint8Array} fileBytes  The whole .chm.
   * @param {import('./itsf.js').ChmDirectory} dir
   */
  constructor(fileBytes, dir) {
    this.bytes = fileBytes;
    this.dir = dir;
    this.lzx = null; // lazily initialised on first compressed read
    this.stream = null; // the fully decompressed MSCompressed blob (cached)
  }

  has(path) {
    return this.dir.map.has(normalise(path));
  }

  /** List all real (non-directory) file paths. */
  list() {
    return this.dir.entries
      .filter((e) => e.length > 0 || (e.name !== '/' && !e.name.endsWith('/')))
      .map((e) => e.name);
  }

  /**
   * @param {string} path
   * @returns {Uint8Array|null}
   */
  getFile(path) {
    const name = normalise(path);
    const entry = this.dir.map.get(name);
    if (!entry) return null;
    if (entry.length === 0) return new Uint8Array(0);

    if (entry.section === 0) {
      const start = this.dir.contentOffset + entry.offset;
      return this.bytes.subarray(start, start + entry.length);
    }
    return this.readCompressed(entry.offset, entry.length);
  }

  _initLzx() {
    if (this.lzx) return;
    const cd = this.getFile('::DataSpace/Storage/MSCompressed/ControlData');
    if (!cd) throw new Error('CHM has compressed content but no ControlData');
    const control = parseControlData(cd);

    let resetTableBytes = null;
    for (const e of this.dir.entries) {
      if (e.name.includes('/InstanceData/ResetTable') || e.name.endsWith('ResetTable')) {
        resetTableBytes = this.getFile(e.name);
        break;
      }
    }
    if (!resetTableBytes) throw new Error('CHM has compressed content but no ResetTable');
    const reset = parseResetTable(resetTableBytes);

    const contentEntry = this.dir.map.get('::DataSpace/Storage/MSCompressed/Content');
    if (!contentEntry || contentEntry.section !== 0) {
      throw new Error('CHM MSCompressed Content blob missing');
    }
    const contentStart = this.dir.contentOffset + contentEntry.offset;
    const compressedLength = Math.min(reset.compressedLength, contentEntry.length);

    this.lzx = { control, reset, contentStart, compressedLength };
  }

  /** Decompress the entire MSCompressed stream once and cache it. */
  _decompressAll() {
    if (this.stream) return this.stream;
    this._initLzx();
    const { control, reset, contentStart, compressedLength } = this.lzx;
    this.stream = decompressStream(
      this.bytes,
      contentStart,
      compressedLength,
      reset.offsets,
      control.resetInterval,
      reset.uncompressedLength,
      reset.frameSize,
      control.windowSize,
    );
    return this.stream;
  }

  /** Read [offset, offset+length) from the decompressed MSCompressed stream. */
  readCompressed(offset, length) {
    const stream = this._decompressAll();
    const end = Math.min(offset + length, stream.length);
    return stream.subarray(offset, end);
  }
}

/** Normalise an internal CHM path: keep leading "::" entries, ensure others start with "/". */
export function normalise(path) {
  if (!path) return path;
  if (path.startsWith('::')) return path;
  if (path.startsWith('/')) return path;
  return '/' + path;
}
