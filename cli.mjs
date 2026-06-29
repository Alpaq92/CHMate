#!/usr/bin/env node
// CHMate command-line tool — list and extract from .chm files using the same
// pure-JS engine the browser app uses.
//
//   node cli.mjs info     file.chm
//   node cli.mjs list     file.chm
//   node cli.mjs toc      file.chm
//   node cli.mjs cat      file.chm /path/inside.htm
//   node cli.mjs extract  file.chm [outDir]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { ChmReader } = await import(pathToFileURL(join(here, 'src/chm/chm-reader.js')).href);

const [, , cmd, file, arg] = process.argv;

if (!cmd || !file) {
  console.log(`CHMate CLI

Usage:
  node cli.mjs info     <file.chm>
  node cli.mjs list     <file.chm>
  node cli.mjs toc      <file.chm>
  node cli.mjs cat      <file.chm> <internal/path>
  node cli.mjs extract  <file.chm> [outDir]`);
  process.exit(cmd ? 1 : 0);
}

const reader = ChmReader.open(readFileSync(file));

function printTree(nodes, depth = 0) {
  for (const n of nodes) {
    console.log('  '.repeat(depth) + '• ' + (n.name || '(untitled)') + (n.local ? '  → ' + n.local : ''));
    if (n.children && n.children.length) printTree(n.children, depth + 1);
  }
}

switch (cmd) {
  case 'info': {
    console.log('Title:        ', reader.title || '(none)');
    console.log('Language (LCID):', reader.lcid, '→', reader.charset);
    console.log('Default topic: ', reader.defaultTopic || '(none)');
    console.log('Contents (.hhc):', reader.contentsPath || '(none)');
    console.log('Index (.hhk):  ', reader.indexPath || '(none)');
    console.log('Files:         ', reader.listFiles().length);
    break;
  }
  case 'list': {
    for (const p of reader.listFiles().sort()) {
      const b = reader.getFile(p);
      console.log(String(b ? b.length : 0).padStart(9), p);
    }
    break;
  }
  case 'toc': {
    printTree(reader.getContents());
    break;
  }
  case 'cat': {
    if (!arg) throw new Error('cat needs an internal path');
    const bytes = reader.getFile(arg);
    if (!bytes) throw new Error('not found: ' + arg);
    process.stdout.write(Buffer.from(bytes));
    break;
  }
  case 'extract': {
    const outDir = arg || file.replace(/\.chm$/i, '') + '_extracted';
    let n = 0;
    for (const p of reader.listFiles()) {
      if (p.startsWith('::') || p.endsWith('/')) continue;
      const bytes = reader.getFile(p);
      if (!bytes) continue;
      const dest = join(outDir, p.replace(/^\//, '').replace(/[<>:"|?*]/g, '_'));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(bytes));
      n++;
    }
    console.log(`Extracted ${n} files → ${outDir}`);
    break;
  }
  default:
    console.error('Unknown command: ' + cmd);
    process.exit(1);
}
