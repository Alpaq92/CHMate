// CHMate — topic renderer & sanitizer (browser only).
//
// CHM is a legacy *and* an active malware vector, so every topic is treated as
// hostile. This module turns a raw topic into an inert HTML document for a
// sandboxed iframe:
//   - strips <script>, event-handler attributes and javascript:/vbscript:/etc.
//   - rewrites <img>/<link rel=stylesheet>/CSS url() to blob: URLs sourced from
//     inside the CHM, so nothing is fetched from the network
//   - rewrites internal <a> links to data attributes the host intercepts
//   - injects a strict Content-Security-Policy as defence in depth
//
// The output is consumed with sandbox="allow-same-origin" (no allow-scripts):
// content scripts can never run, the CSP blocks external loads, and the host
// (same origin) attaches the navigation handler.

const BLOCKED_SCHEMES = /^\s*(javascript|vbscript|data:text\/html|data:application|about|mhtml|file|ms-its|mk):/i;

const MIME = {
  css: 'text/css',
  htm: 'text/html',
  html: 'text/html',
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  js: 'text/javascript',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
};

function mimeOf(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/**
 * A blob-URL cache keyed by CHM path, so shared assets (one stylesheet, a
 * sprite reused across topics) decode and allocate a URL only once.
 */
export class BlobCache {
  constructor(reader) {
    this.reader = reader;
    this.urls = new Map(); // path -> objectURL
  }

  urlFor(path) {
    if (this.urls.has(path)) return this.urls.get(path);
    const bytes = this.reader.getFile(path);
    if (!bytes) {
      this.urls.set(path, null);
      return null;
    }
    const blob = new Blob([bytes], { type: mimeOf(path) });
    const url = URL.createObjectURL(blob);
    this.urls.set(path, url);
    return url;
  }

  /** Cache + return a blob: URL for an HTML string (used for nested frames). */
  urlForHtml(key, html) {
    if (this.urls.has(key)) return this.urls.get(key);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    this.urls.set(key, url);
    return url;
  }

  revokeAll() {
    for (const url of this.urls.values()) if (url) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

const CSP =
  "default-src 'none'; " +
  "img-src blob: data:; " +
  "style-src blob: data: 'unsafe-inline'; " +
  "font-src blob: data:; " +
  "media-src blob: data:; " +
  "frame-src blob:; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'";

const BASE_STYLE = `
  html { background: #f4f4f6; }
  body { background: #ffffff; color: #1b1b1f; margin: 0; padding: 22px 26px;
         max-width: 100%; overflow-wrap: break-word; }
  img { max-width: 100%; height: auto; }
  a { color: #1a56db; }
  ::selection { background: #b9d2ff; }
  mark.chm-find { background: #ffd54a; color: #1b1b1f; padding: 0; }
  mark.chm-find.chm-active { background: #ff9d3b; box-shadow: 0 0 0 2px #ff9d3b; }

  /* Persistent custom scrollbars (no native stepper arrows, no auto-hiding
     thin overlay). Firefox ignores ::-webkit-scrollbar, so it gets a thin
     scrollbar via the @supports fallback. */
  ::-webkit-scrollbar { width: 12px; height: 12px; }
  ::-webkit-scrollbar-button { display: none; }
  ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(135,135,150,0.55); border-radius: 7px;
    border: 3px solid transparent; background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(135,135,150,0.85); }

  /* Document theme. CHM topics carry arbitrary inline colours, so dark mode is
     a smart-invert filter on the root with media re-inverted back to normal. */
  html[data-theme="dark"] { filter: invert(1) hue-rotate(180deg); }
  html[data-theme="dark"] img, html[data-theme="dark"] picture, html[data-theme="dark"] video,
  html[data-theme="dark"] svg, html[data-theme="dark"] canvas, html[data-theme="dark"] embed,
  html[data-theme="dark"] object, html[data-theme="dark"] iframe { filter: invert(1) hue-rotate(180deg); }
  @media (prefers-color-scheme: dark) {
    html[data-theme="system"] { filter: invert(1) hue-rotate(180deg); }
    html[data-theme="system"] img, html[data-theme="system"] picture, html[data-theme="system"] video,
    html[data-theme="system"] svg, html[data-theme="system"] canvas, html[data-theme="system"] embed,
    html[data-theme="system"] object, html[data-theme="system"] iframe { filter: invert(1) hue-rotate(180deg); }
  }
`;

/**
 * Build a sanitized, self-contained HTML string for a topic.
 * @param {import('./chm/chm-reader.js').ChmReader} reader
 * @param {string} path  absolute CHM path of the topic
 * @param {BlobCache} blobs
 * @returns {string} HTML ready for iframe.srcdoc
 */
export function renderTopic(reader, path, blobs, depth = 0) {
  const raw = reader.getText(path) || '';
  const doc = new DOMParser().parseFromString(raw, 'text/html');

  // Drop scripts, frames-to-external, <base>, and other live elements.
  doc.querySelectorAll('script, noscript, base, meta[http-equiv], object, embed, applet').forEach((el) => el.remove());

  // Strip event handlers and dangerous attribute values everywhere.
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name === 'src' || name === 'background') && BLOCKED_SCHEMES.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }

  const resolve = (ref) => reader.resolvePath(path, ref);

  // <img>, <input type=image>, element backgrounds -> blob: URLs.
  doc.querySelectorAll('img[src], input[type="image"][src]').forEach((img) => {
    const url = blobs.urlFor(resolve(img.getAttribute('src')));
    if (url) img.setAttribute('src', url);
    else img.removeAttribute('src');
    img.removeAttribute('srcset');
    img.removeAttribute('loading');
  });
  doc.querySelectorAll('[background]').forEach((el) => {
    const url = blobs.urlFor(resolve(el.getAttribute('background')));
    if (url) el.setAttribute('background', url);
    else el.removeAttribute('background');
  });

  // External stylesheets -> inline <style> with rewritten url()s.
  doc.querySelectorAll('link[rel~="stylesheet" i][href]').forEach((link) => {
    const cssPath = resolve(link.getAttribute('href'));
    const css = reader.getText(cssPath); // charset-aware decode via the engine
    if (css != null) {
      const style = doc.createElement('style');
      style.textContent = rewriteCssUrls(css, cssPath, reader, blobs);
      link.replaceWith(style);
    } else {
      link.remove();
    }
  });

  // Inline <style> blocks and style="" attributes.
  doc.querySelectorAll('style').forEach((style) => {
    style.textContent = rewriteCssUrls(style.textContent || '', path, reader, blobs);
  });
  doc.querySelectorAll('[style]').forEach((el) => {
    const s = el.getAttribute('style');
    if (s && s.includes('url(')) el.setAttribute('style', rewriteCssUrls(s, path, reader, blobs));
  });

  // Frames -> a blob of the *recursively sanitized* target (its own CSP, no
  // raw HTML, no network egress), so framesets render safely. A depth cap
  // prevents frame-reference loops.
  doc.querySelectorAll('frame[src], iframe[src]').forEach((fr) => {
    const target = resolve(fr.getAttribute('src'));
    if (depth < 3 && reader.hasFile(target)) {
      fr.setAttribute('src', blobs.urlForHtml('frame:' + target, renderTopic(reader, target, blobs, depth + 1)));
    } else {
      fr.removeAttribute('src');
    }
  });

  // Links: classify internal vs external; the host intercepts both.
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href').trim();
    if (href.startsWith('#')) return; // in-page anchor, leave as-is
    if (/^(https?|mailto|ftp):/i.test(href)) {
      a.setAttribute('data-chm-ext', href);
      a.setAttribute('href', '#');
      return;
    }
    const abs = resolve(href);
    const frag = (href.match(/#(.*)$/) || [, ''])[1];
    a.setAttribute('data-chm-href', abs);
    if (frag) a.setAttribute('data-chm-frag', frag);
    a.setAttribute('href', '#');
  });

  // Assemble the final document with CSP + base styling injected first.
  const head = doc.head || doc.createElement('head');
  const cspMeta = doc.createElement('meta');
  cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
  cspMeta.setAttribute('content', CSP);
  head.insertBefore(cspMeta, head.firstChild);

  const baseStyle = doc.createElement('style');
  baseStyle.textContent = BASE_STYLE;
  head.appendChild(baseStyle);

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

function rewriteCssUrls(css, cssPath, reader, blobs) {
  // Drop @import (would pull external/inaccessible resources) and rewrite url().
  let out = css.replace(/@import\s+[^;]+;/gi, '');
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, ref) => {
    const r = ref.trim();
    if (/^(data:|blob:|#)/i.test(r)) return m;
    if (/^[a-z][a-z0-9+.-]*:/i.test(r)) return 'none'; // external/unknown scheme — block egress
    const url = blobs.urlFor(reader.resolvePath(cssPath, r));
    return url ? `url("${url}")` : 'none';
  });
  return out;
}
