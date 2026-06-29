// CHMate — parse the special metadata files (#SYSTEM, #WINDOWS, #STRINGS).
//
// These hold the help file's title, default topic, contents/index file names,
// and language — everything the reader needs to bootstrap navigation.

import { ByteReader } from './byte-reader.js';

const latin1 = new TextDecoder('latin1');

function trimNul(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

function cstr(bytes) {
  return latin1.decode(trimNul(bytes));
}

/**
 * Parse the `/#SYSTEM` record stream.
 * @param {Uint8Array} bytes
 * @returns {{version:number, contentsFile?:string, indexFile?:string,
 *            defaultTopic?:string, title?:string, lcid?:number,
 *            compiledFile?:string, compiler?:string, defaultFont?:string}}
 */
export function parseSystem(bytes) {
  const out = {};
  if (!bytes || bytes.length < 4) return out;
  const r = new ByteReader(bytes);
  out.version = r.u32();
  while (r.pos + 4 <= bytes.length) {
    const code = r.u16();
    const len = r.u16();
    if (r.pos + len > bytes.length) break;
    const data = bytes.subarray(r.pos, r.pos + len);
    r.skip(len);
    switch (code) {
      case 0:
        out.contentsFile = cstr(data);
        break;
      case 1:
        out.indexFile = cstr(data);
        break;
      case 2:
        out.defaultTopic = cstr(data);
        break;
      case 3:
        out.title = cstr(data);
        // Keep raw bytes so the caller can re-decode with the help charset
        // once the LCID is known (the title may be non-ASCII).
        out.titleBytes = trimNul(data);
        break;
      case 4:
        if (len >= 4) out.lcid = new ByteReader(data).u32();
        break;
      case 6:
        out.compiledFile = cstr(data);
        break;
      case 9:
        out.compiler = cstr(data);
        break;
      case 16:
        out.defaultFont = cstr(data);
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Parse `/#WINDOWS` for a window definition (fallback title / default topic /
 * contents / index). The record layout varies by version; we read the string
 * offsets defensively and resolve them against `/#STRINGS`.
 * @returns {{title?:string, contentsFile?:string, indexFile?:string, defaultTopic?:string}}
 */
export function parseWindows(windowsBytes, stringsBytes) {
  const out = {};
  if (!windowsBytes || windowsBytes.length < 8) return out;
  const r = new ByteReader(windowsBytes);
  const numEntries = r.u32();
  const entrySize = r.u32();
  if (!numEntries || entrySize < 0x60) return out;

  const strAt = (off) => {
    if (!stringsBytes || off === 0 || off >= stringsBytes.length) return undefined;
    let end = off;
    while (end < stringsBytes.length && stringsBytes[end] !== 0) end++;
    const s = latin1.decode(stringsBytes.subarray(off, end));
    return s || undefined;
  };

  // First window entry only. Offsets into #STRINGS sit at known positions.
  const base = 8;
  const u32 = (rel) => {
    const p = base + rel;
    if (p + 4 > windowsBytes.length) return 0;
    return new ByteReader(windowsBytes, p).u32();
  };
  out.title = strAt(u32(0x14));
  out.contentsFile = strAt(u32(0x60));
  out.indexFile = strAt(u32(0x64));
  out.defaultTopic = strAt(u32(0x68));
  return out;
}
