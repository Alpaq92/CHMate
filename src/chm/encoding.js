// CHMate — character-encoding selection.
//
// CHM topics predate UTF-8 ubiquity; the right charset comes (in order) from
// the HTML's own <meta charset>, then the help file's LCID/codepage, then a
// Western-European default. TextDecoder handles all the legacy codepages.

// Primary-language (LCID & 0x3FF) -> legacy Windows codepage.
const LANG_TO_CHARSET = {
  0x01: 'windows-1256', // Arabic
  0x02: 'windows-1251', // Bulgarian
  0x03: 'windows-1252', // Catalan
  0x04: 'gbk', // Chinese (Simplified/Traditional resolved below)
  0x05: 'windows-1250', // Czech
  0x06: 'windows-1252', // Danish
  0x07: 'windows-1252', // German
  0x08: 'windows-1253', // Greek
  0x09: 'windows-1252', // English
  0x0a: 'windows-1252', // Spanish
  0x0b: 'windows-1252', // Finnish
  0x0c: 'windows-1252', // French
  0x0d: 'windows-1255', // Hebrew
  0x0e: 'windows-1250', // Hungarian
  0x0f: 'windows-1252', // Icelandic
  0x10: 'windows-1252', // Italian
  0x11: 'shift_jis', // Japanese
  0x12: 'euc-kr', // Korean
  0x13: 'windows-1252', // Dutch
  0x14: 'windows-1252', // Norwegian
  0x15: 'windows-1250', // Polish
  0x16: 'windows-1252', // Portuguese
  0x18: 'windows-1250', // Romanian
  0x19: 'windows-1251', // Russian
  0x1a: 'windows-1250', // Croatian/Serbian (Latin)
  0x1b: 'windows-1250', // Slovak
  0x1c: 'windows-1250', // Albanian
  0x1d: 'windows-1252', // Swedish
  0x1e: 'windows-874', // Thai
  0x1f: 'windows-1254', // Turkish
  0x22: 'windows-1251', // Ukrainian
  0x24: 'windows-1250', // Slovenian
  0x25: 'windows-1257', // Estonian
  0x26: 'windows-1257', // Latvian
  0x27: 'windows-1257', // Lithuanian
  0x29: 'windows-1256', // Farsi
  0x2a: 'windows-1258', // Vietnamese
};

/** Map an LCID to a TextDecoder-compatible charset label. */
export function charsetFromLcid(lcid) {
  if (!lcid) return 'windows-1252';
  const primary = lcid & 0x3ff;
  if (primary === 0x04) {
    // Chinese: Traditional sublangs (Taiwan 0x04, Hong Kong 0x0C) use Big5.
    const sub = (lcid >> 10) & 0x3f;
    return sub === 0x01 || sub === 0x03 ? 'big5' : 'gbk';
  }
  return LANG_TO_CHARSET[primary] || 'windows-1252';
}

/** Sniff a charset from an HTML byte head's <meta charset> / content-type. */
export function charsetFromHtml(bytes) {
  const head = latinHead(bytes, 1024).toLowerCase();
  let m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-]+)/i);
  if (m) return normaliseCharset(m[1]);
  m = head.match(/charset\s*=\s*["']?\s*([a-z0-9_\-]+)/i);
  if (m) return normaliseCharset(m[1]);
  return null;
}

function latinHead(bytes, n) {
  const len = Math.min(bytes.length, n);
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function normaliseCharset(cs) {
  const c = cs.toLowerCase().trim();
  const alias = {
    'utf8': 'utf-8',
    'iso-8859-1': 'windows-1252',
    'latin1': 'windows-1252',
    'shift-jis': 'shift_jis',
    'sjis': 'shift_jis',
    'ms932': 'shift_jis',
    'cp1250': 'windows-1250',
    'cp1251': 'windows-1251',
    'cp1252': 'windows-1252',
    'gb2312': 'gbk',
    'gb_2312-80': 'gbk',
  };
  return alias[c] || c;
}

/** Decode a plain string (e.g. a title) with a known charset and a safe fallback. */
export function decodeString(bytes, charset) {
  try {
    return new TextDecoder(charset || 'windows-1252').decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Decode bytes as text, preferring the HTML's own declared charset. */
export function decodeText(bytes, fallbackCharset) {
  const charset = charsetFromHtml(bytes) || fallbackCharset || 'windows-1252';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
