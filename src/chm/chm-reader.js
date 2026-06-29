// CHMate — high-level reader API.
//
// One class that opens a .chm and exposes everything a viewer needs:
// file listing & extraction, the title/default-topic/language metadata, and
// the table-of-contents / index trees. Environment-agnostic: works on a
// Uint8Array or ArrayBuffer in Node or the browser.

import { parseContainer } from './itsf.js';
import { ContentResolver, normalise } from './content.js';
import { parseSystem, parseWindows } from './system.js';
import { parseSitemap } from './sitemap.js';
import { charsetFromLcid, decodeText, decodeString } from './encoding.js';

export class ChmReader {
  /**
   * @param {ArrayBuffer|Uint8Array} input
   * @returns {ChmReader}
   */
  static open(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return new ChmReader(bytes);
  }

  constructor(bytes) {
    this.bytes = bytes;
    this.dir = parseContainer(bytes);
    this.content = new ContentResolver(bytes, this.dir);

    this.system = parseSystem(this.content.getFile('/#SYSTEM'));
    const win = parseWindows(this.content.getFile('/#WINDOWS'), this.content.getFile('/#STRINGS'));

    this.lcid = this.system.lcid || this.dir.languageId || 0;
    this.charset = charsetFromLcid(this.lcid);

    this.title =
      (this.system.titleBytes ? decodeString(this.system.titleBytes, this.charset) : undefined) ||
      first(this.system.title, win.title) ||
      '';

    this.contentsPath = pickExisting(this, this.system.contentsFile, win.contentsFile, this._firstByExt('.hhc'));
    this.indexPath = pickExisting(this, this.system.indexFile, win.indexFile, this._firstByExt('.hhk'));
    this.defaultTopic = pickExisting(
      this,
      this.system.defaultTopic,
      win.defaultTopic,
      this._firstByExt('.htm'),
      this._firstByExt('.html'),
    );

    this._contentsTree = null;
    this._indexTree = null;
  }

  /** All real file paths in the archive (excludes directory placeholders). */
  listFiles() {
    return this.dir.entries
      .filter((e) => !e.name.endsWith('/') && !(e.name.startsWith('::') && e.length === 0))
      .map((e) => e.name);
  }

  /** Internal/meta files such as ::DataSpace/... and the /# records. */
  hasFile(path) {
    return this.content.has(path);
  }

  /** @returns {Uint8Array|null} */
  getFile(path) {
    return this.content.getFile(path);
  }

  /** Decode a file to text using the help file's (or page's) charset. */
  getText(path, charset) {
    const bytes = this.getFile(path);
    if (!bytes) return null;
    return decodeText(bytes, charset || this.charset);
  }

  /** Parsed table-of-contents tree (or [] if none). */
  getContents() {
    if (this._contentsTree) return this._contentsTree;
    this._contentsTree = this.contentsPath ? parseSitemap(this.getText(this.contentsPath) || '') : [];
    return this._contentsTree;
  }

  /** Parsed index tree (or [] if none). */
  getIndex() {
    if (this._indexTree) return this._indexTree;
    this._indexTree = this.indexPath ? parseSitemap(this.getText(this.indexPath) || '') : [];
    return this._indexTree;
  }

  /**
   * Resolve a (possibly relative) link against a base topic path, returning a
   * normalised absolute CHM path (e.g. "/html/page.htm"). Strips queries and
   * fragments for lookup; callers keep the fragment separately if needed.
   */
  resolvePath(base, ref) {
    let r = String(ref).replace(/\\/g, '/');
    const its = r.match(/::(.+)$/); // ms-its:file.chm::/path
    if (its) r = its[1];
    if (/^[a-z]+:/i.test(r) && !r.startsWith('ms-its:')) return r; // external scheme
    if (r.startsWith('/')) return normalise(stripAnchor(r));

    const baseDir = base.replace(/\\/g, '/').replace(/\/[^/]*$/, '/');
    const stack = (baseDir + stripAnchor(r)).split('/');
    const resolved = [];
    for (const part of stack) {
      if (part === '' || part === '.') continue;
      if (part === '..') resolved.pop();
      else resolved.push(part);
    }
    return '/' + resolved.join('/');
  }

  /** First non-meta entry whose name ends with `ext` (e.g. ".htm"). */
  _firstByExt(ext) {
    const e = this.dir.entries.find((x) => x.name.toLowerCase().endsWith(ext) && !x.name.startsWith('::'));
    return e ? e.name : undefined;
  }
}

/** Drop a `#fragment` / `?query` from a CHM path. Shared with the host UI. */
export function stripAnchor(p) {
  return p.replace(/[#?].*$/, '');
}

function first(...vals) {
  for (const v of vals) if (v) return v;
  return undefined;
}

function pickExisting(reader, ...candidates) {
  const norm = (c) => normalise(String(c).replace(/\\/g, '/'));
  for (const c of candidates) if (c && reader.dir.map.has(norm(c))) return norm(c);
  // Fall back to the first non-empty candidate even if not found in the map.
  for (const c of candidates) if (c) return norm(c);
  return undefined;
}
