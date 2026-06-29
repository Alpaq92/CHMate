// CHMate — ITSS/ITSF container parser (own MIT code).
//
// A .chm file is an "ITSS" filesystem:
//   ITSF header  ->  ITSP directory header  ->  PMGL listing chunks (a flat
//   B-tree of named entries)  ->  content sections.
//
// Reference: Pabs' chmspec (ITSF.html, Internal.html, Storage.html) and
// Matthew Russotto's CHM format notes. Byte layout verified against real
// Windows .chm fixtures.
//
// Every entry names a file and says where its bytes live:
//   section 0 (Uncompressed) -> a raw slice of the .chm at contentOffset+offset
//   section 1 (MSCompressed) -> an offset into the LZX-decompressed blob
//
// This module does not decompress anything; it only produces the directory.

import { ByteReader, utf8Slice } from './byte-reader.js';

const ITSF_GUID_1 = '{7C01FD10-7BAA-11D0-9E0C-00A0C922E6EC}';
const ITSF_GUID_2 = '{7C01FD11-7BAA-11D0-9E0C-00A0C922E6EC}';
const ITSP_GUID = '{5D02926A-212E-11D0-9DF9-00A0C922E6EC}';

/**
 * @typedef {Object} ChmEntry
 * @property {string} name      Full internal path, e.g. "/index.htm" or "::DataSpace/NameList".
 * @property {number} section   0 = Uncompressed, 1 = MSCompressed.
 * @property {number} offset    Byte offset within the section's content space.
 * @property {number} length    Uncompressed length in bytes.
 */

/**
 * @typedef {Object} ChmDirectory
 * @property {number} version          ITSF version (expected 3).
 * @property {number} languageId       LCID from the ITSF header.
 * @property {number} fileSize         Total file size as declared in header section 0.
 * @property {number} contentOffset    Absolute file offset of content section 0 (uncompressed base).
 * @property {number} chunkSize        Directory chunk size (usually 0x1000).
 * @property {ChmEntry[]} entries      All directory entries, in directory order.
 * @property {Map<string, ChmEntry>} map  name -> entry (last wins, like the real format).
 */

/**
 * Parse the ITSF container of a .chm file.
 * @param {Uint8Array} bytes
 * @returns {ChmDirectory}
 */
export function parseContainer(bytes) {
  const r = new ByteReader(bytes);

  // --- ITSF header ---
  const magic = utf8Slice(bytes, 0, 4);
  if (magic !== 'ITSF') {
    throw new Error(`Not a CHM file: expected "ITSF" magic, got ${JSON.stringify(magic)}`);
  }
  r.seek(4);
  const version = r.u32();
  const headerLength = r.u32();
  r.u32(); // unknown (usually 1)
  r.u32(); // last-modified timestamp
  const languageId = r.u32();
  const guid1 = r.guid();
  const guid2 = r.guid();
  if (guid1 !== ITSF_GUID_1 || guid2 !== ITSF_GUID_2) {
    // Not fatal — warn via thrown context only if the rest fails. Most real
    // files match exactly; mismatches usually mean a corrupt/unknown variant.
    throw new Error(`Unexpected ITSF GUIDs: ${guid1} / ${guid2}`);
  }

  // Header section table: two {u64 offset, u64 length} entries.
  const sec0Offset = r.u64();
  const sec0Length = r.u64();
  const sec1Offset = r.u64(); // ITSP directory header
  const sec1Length = r.u64();

  // v3 adds the absolute offset of content section 0 (the uncompressed base).
  let contentOffset;
  if (version >= 3) {
    contentOffset = r.u64();
  } else {
    // v2: content section 0 begins right after the directory.
    contentOffset = sec1Offset + sec1Length;
  }

  // Header section 0 — holds the real file size.
  r.seek(sec0Offset);
  r.u32(); // 0x01FE
  r.u32(); // 0
  const fileSize = r.u64();
  void sec0Length;

  // --- ITSP directory header (header section 1) ---
  r.seek(sec1Offset);
  const itspMagic = utf8Slice(bytes, sec1Offset, 4);
  if (itspMagic !== 'ITSP') {
    throw new Error(`Expected "ITSP" directory header, got ${JSON.stringify(itspMagic)}`);
  }
  r.seek(sec1Offset + 4);
  r.u32(); // ITSP version (1)
  const itspHeaderLength = r.u32();
  r.u32(); // unknown (0x0a)
  const chunkSize = r.u32();
  r.u32(); // density
  const indexTreeDepth = r.u32();
  r.i32(); // root index chunk number (-1 if none)
  const firstPmglChunk = r.u32();
  const lastPmglChunk = r.u32();
  r.i32(); // unknown (-1)
  const totalChunks = r.u32();
  r.u32(); // language id (directory)
  const itspGuid = r.guid();
  if (itspGuid !== ITSP_GUID) {
    throw new Error(`Unexpected ITSP GUID: ${itspGuid}`);
  }
  void indexTreeDepth;

  // Directory chunks begin immediately after the ITSP header.
  const chunksBase = sec1Offset + itspHeaderLength;

  const entries = [];
  // A linear scan of the PMGL leaf chunks is sufficient — PMGI index chunks
  // only accelerate lookups in huge files and are not needed for correctness.
  // The chunk range is bounded by the actual file so a corrupt header can't
  // run us off the end.
  const maxChunk = Math.min(lastPmglChunk, totalChunks - 1, Math.floor((bytes.length - chunksBase) / chunkSize) - 1);
  for (let chunk = Math.max(0, firstPmglChunk); chunk <= maxChunk; chunk++) {
    const chunkStart = chunksBase + chunk * chunkSize;
    parsePmglChunk(bytes, chunkStart, chunkSize, entries);
  }

  const map = new Map();
  for (const e of entries) map.set(e.name, e);

  return {
    version,
    languageId,
    fileSize: fileSize || bytes.length,
    contentOffset,
    chunkSize,
    entries,
    map,
  };
}

/** Parse one PMGL (listing) chunk, appending its entries. */
function parsePmglChunk(bytes, chunkStart, chunkSize, entries) {
  const tag = utf8Slice(bytes, chunkStart, 4);
  if (tag !== 'PMGL') return; // PMGI (index) chunk or padding — skip.

  const r = new ByteReader(bytes, chunkStart + 4);
  const freeSpace = r.u32(); // free + quickref bytes at the end of the chunk
  r.u32(); // always 0
  r.i32(); // previous listing chunk
  r.i32(); // next listing chunk

  // Entries are packed from offset 20 up to (chunkSize - freeSpace); the tail
  // holds the quickref acceleration table, which we don't need.
  const entriesEnd = chunkStart + chunkSize - freeSpace;
  while (r.pos < entriesEnd) {
    const nameLen = r.encint();
    // A zero-length name at this point means we've hit padding/quickref slack.
    if (nameLen === 0 || r.pos + nameLen > entriesEnd) break;
    const name = utf8Slice(bytes, r.pos, nameLen);
    r.skip(nameLen);
    const section = r.encint();
    const offset = r.encint();
    const length = r.encint();
    entries.push({ name, section, offset, length });
  }
}
