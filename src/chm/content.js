// CHMate — content resolution: path -> bytes.
//
// Uncompressed entries are a raw slice of the file. Compressed (section 1)
// entries live inside one big LZX stream (reset every `resetInterval` frames,
// with the ResetTable giving each frame's compressed offset). Because LZX
// matches carry across reset boundaries, the whole MSCompressed stream is
// decompressed once on first compressed read and cached for the reader's
// lifetime; subsequent compressed reads are plain slices of that buffer.

import { ByteReader } from './byte-reader.js';
import { decompressStream, FRAME_SIZE } from './lzx.js';

const RESET_TABLE_PATH =
  '::DataSpace/Storage/MSCompressed/Transform/{7FC28940-9D31-11D0-9B27-00A0C91E9C7C}/InstanceData/ResetTable';

/** Parse the `LZXC` ControlData record. */
function parseControlData(bytes) {
  const r = new ByteReader(bytes);
  r.u32(); // number of DWORDs (6)
  const sig = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  r.skip(4);
  if (sig !== 'LZXC') throw new Error(`Unsupported compression signature ${JSON.stringify(sig)}`);
  r.u32(); // version
  const resetInterval = Math.max(1, r.u32()); // frames between resets (guard against 0)
  const windowSizeFrames = r.u32(); // window size in 0x8000-byte frames
  return { resetInterval, windowSize: windowSizeFrames * FRAME_SIZE };
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
  // Clamp against the buffer so a hostile header can't request a huge alloc.
  const n = Math.min(numEntries, Math.max(0, Math.floor((bytes.length - 40) / 8)));
  const offsets = new Array(n);
  for (let i = 0; i < n; i++) offsets[i] = r.u64();
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

    // The ResetTable lives at a canonical path; fall back to a name match only
    // if a writer used a different transform GUID.
    let resetTableBytes = this.getFile(RESET_TABLE_PATH);
    if (!resetTableBytes) {
      const e = this.dir.entries.find((x) => x.name.endsWith('/InstanceData/ResetTable'));
      if (e) resetTableBytes = this.getFile(e.name);
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
