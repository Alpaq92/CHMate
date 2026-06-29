// CHMate test harness.
//
// CHM has no checksums, so correctness is proven by self-consistency: every
// file must decompress to exactly its declared length and, where its type is
// known, carry the right magic bytes / be valid text. A single LZX error
// produces garbage that fails these checks immediately.
//
//   node test/run.mjs                 -> tests bundled samples/*.chm
//   node test/run.mjs a.chm b.chm     -> tests the given files too
//
// Exits non-zero if any file fails.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { ChmReader } = await import(pathToFileURL(join(root, 'src/chm/chm-reader.js')).href);
const { parseSitemap } = await import(pathToFileURL(join(root, 'src/chm/sitemap.js')).href);

function magicCheck(name, b) {
  const n = name.toLowerCase();
  const ascii = (k) => String.fromCharCode(...b.subarray(0, k));
  if (n.endsWith('.gif')) return ascii(4) === 'GIF8';
  if (n.endsWith('.png')) return b[0] === 0x89 && ascii(4).slice(1) === 'PNG';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return b[0] === 0xff && b[1] === 0xd8;
  if (n.endsWith('.bmp')) return ascii(2) === 'BM';
  if (n.endsWith('.htm') || n.endsWith('.html')) {
    const h = String.fromCharCode(...b.subarray(0, Math.min(600, b.length))).toLowerCase();
    return /<html|<!doctype|<head|<body|<\?xml|<title/.test(h);
  }
  if (n.endsWith('.css') || n.endsWith('.js') || n.endsWith('.hhc') || n.endsWith('.hhk')) {
    let ok = 0;
    const len = Math.min(b.length, 2000);
    for (let i = 0; i < len; i++) {
      const c = b[i];
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 160) ok++;
    }
    return len === 0 || ok / len > 0.9;
  }
  return null; // unknown type — skip
}

const args = process.argv.slice(2);
const sampleDir = join(root, 'samples');
const files = args.length
  ? args
  : existsSync(sampleDir)
    ? readdirSync(sampleDir)
        .filter((f) => f.toLowerCase().endsWith('.chm'))
        .map((f) => join(sampleDir, f))
    : [];

if (!files.length) {
  console.error('No .chm files to test. Pass paths or add files to samples/.');
  process.exit(1);
}

let suites = 0;
let failures = 0;
let totalChecked = 0;

for (const file of files) {
  suites++;
  const name = file.split(/[\\/]/).pop();
  let reader;
  try {
    reader = ChmReader.open(readFileSync(file));
  } catch (err) {
    console.log(`✗ ${name}: failed to open — ${err.message}`);
    failures++;
    continue;
  }

  let checked = 0;
  let bad = 0;
  const fails = [];
  for (const e of reader.dir.entries) {
    if (e.length === 0 || e.name.endsWith('/') || e.name.startsWith('::')) continue;
    let bytes;
    try {
      bytes = reader.getFile(e.name);
    } catch (err) {
      bad++;
      fails.push(`${e.name}: threw ${err.message}`);
      continue;
    }
    if (!bytes || bytes.length !== e.length) {
      bad++;
      fails.push(`${e.name}: length ${bytes ? bytes.length : 'null'} != ${e.length}`);
      continue;
    }
    const m = magicCheck(e.name, bytes);
    if (m === null) continue;
    checked++;
    if (!m) {
      bad++;
      fails.push(`${e.name}: bad content/magic (len ${bytes.length})`);
    }
  }
  totalChecked += checked;

  // Metadata sanity: title decodes, sitemaps parse without throwing.
  let meta = '';
  try {
    const toc = reader.getContents();
    const idx = reader.getIndex();
    meta = `toc:${count(toc)} idx:${count(idx)}`;
    parseSitemap('<ul><li><object type="text/sitemap"><param name="Name" value="x"></object></ul>'); // smoke
  } catch (err) {
    bad++;
    fails.push('metadata: ' + err.message);
  }

  if (bad === 0) {
    console.log(`✓ ${name}: ${checked} content-checked, ${reader.listFiles().length} files, ${meta}`);
  } else {
    failures++;
    console.log(`✗ ${name}: ${bad} failure(s) of ${checked} checked`);
    fails.slice(0, 10).forEach((f) => console.log('    - ' + f));
  }
}

function count(nodes) {
  let c = 0;
  for (const n of nodes) {
    c++;
    if (n.children) c += count(n.children);
  }
  return c;
}

console.log(`\n${suites - failures}/${suites} suites passed, ${totalChecked} files content-checked.`);
process.exit(failures ? 1 : 0);
