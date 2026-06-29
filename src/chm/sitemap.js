// CHMate — parse CHM "sitemap" files: the .hhc (table of contents) and .hhk
// (index). Both are HTML files of nested <UL> lists whose entries are
// <OBJECT type="text/sitemap"> blocks carrying Name/Local params.
//
// Real-world .hhc/.hhk files are frequently malformed (unclosed <LI>, stray
// tags, missing </UL>), so this is a deliberately tolerant tag scanner rather
// than a strict HTML parse — and it has no DOM dependency, so it runs in Node
// and the browser alike.

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const e = ENTITIES[body.toLowerCase()];
    return e !== undefined ? e : m;
  });
}

// Pull name="value" / name='value' / name=value attributes from a tag body.
function parseAttrs(attrText) {
  const attrs = {};
  const re = /([a-z0-9_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m;
  while ((m = re.exec(attrText))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

/**
 * @typedef {Object} SitemapNode
 * @property {string} name   Display label.
 * @property {string} [local] Target file path (relative to the CHM root).
 * @property {string} [url]   External URL, if any.
 * @property {SitemapNode[]} children
 */

/**
 * Parse a .hhc/.hhk sitemap into a tree of nodes.
 * @param {string} html  decoded sitemap text
 * @returns {SitemapNode[]}  top-level nodes
 */
export function parseSitemap(html) {
  const root = { name: '', children: [] };
  const parents = [root];
  let lastItem = null;
  let inObject = false;
  let objType = '';
  let params = null;

  const re = /<\s*(\/?)\s*(ul|object|param)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3];

    if (tag === 'ul') {
      if (!closing) {
        parents.push(lastItem || parents[parents.length - 1]);
        lastItem = null;
      } else if (parents.length > 1) {
        lastItem = parents.pop();
      }
    } else if (tag === 'object') {
      if (!closing) {
        const a = parseAttrs(attrs);
        objType = (a.type || '').toLowerCase();
        inObject = objType === 'text/sitemap';
        params = {};
      } else {
        if (inObject && params) {
          const node = makeNode(params);
          if (node) {
            parents[parents.length - 1].children.push(node);
            lastItem = node;
          }
        }
        inObject = false;
        params = null;
      }
    } else if (tag === 'param' && inObject && params && !closing) {
      const a = parseAttrs(attrs);
      if (a.name) params[a.name.toLowerCase()] = a.value ?? '';
    }
  }

  return root.children;
}

function makeNode(params) {
  const name = params['name'];
  if (name === undefined && params['local'] === undefined && params['url'] === undefined) return null;
  const node = { name: name || '', children: [] };
  if (params['local'] !== undefined) node.local = normaliseLocal(params['local']);
  if (params['url'] !== undefined) node.url = params['url'];
  return node;
}

// .hhc "Local" values use Windows-style separators and may be relative.
function normaliseLocal(local) {
  let p = local.replace(/\\/g, '/').trim();
  // Strip an "ms-its:foo.chm::" prefix if present, keep the in-chm path.
  const its = p.match(/::(.+)$/);
  if (its) p = its[1];
  return p;
}
