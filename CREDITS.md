# Credits & licenses

CHMate is MIT-licensed. Everything it ships is permissively licensed; nothing
here is GPL/LGPL.

| Part | Origin | License |
| --- | --- | --- |
| ITSS/ITSF container parser (`src/chm/itsf.js`, `byte-reader.js`) | Own implementation, written against the [chmspec](http://www.nongnu.org/chmspec/latest/) and [Russotto's notes](http://www.russotto.net/chm/chmformat.html) | MIT |
| Content resolution, ResetTable/ControlData (`src/chm/content.js`) | Own implementation | MIT |
| `#SYSTEM` / `#WINDOWS`, sitemap (`.hhc`/`.hhk`), encoding, reader API | Own implementation | MIT |
| **LZX decompressor** (`src/chm/lzx.js`) | Own implementation, written against the [\[MS-PATCH\] LZX spec](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-patch/) | MIT |
| Browser UI, sanitizer, renderer (`index.html`, `css/`, `src/app.js`, `src/render.js`) | Own implementation | MIT |
| Demo file (`samples/putty.chm`) | PuTTY documentation © Simon Tatham et al. | PuTTY (MIT-style) — see `samples/putty.chm.LICENCE` |

## LZX decoder

The hardest part of reading CHM is LZX decompression. CHMate's `src/chm/lzx.js`
is an **original implementation** written against Microsoft's published
[\[MS-PATCH\] LZX specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-patch/),
using the standard public-domain canonical-Huffman decode technique (a
length-by-length walk, as in zlib's `puff`). No third-party decoder code is
used or shipped; the result carries no copyleft or attribution obligations
beyond CHMate's own MIT license.

Correctness is established by self-consistency (see `test/run.mjs`): the
decoder was validated byte-for-byte across 13 real `.chm` files (1,400+
internal files, including PuTTY's manual and Windows system Help). Other open
implementations — [mlocati/chm-lib](https://github.com/mlocati/chm-lib) (MIT)
and libmspack — were consulted only to cross-check observed behaviour during
development; none of their code is present here.

## Specifications & references (no code used)

- chmspec — [ITSF](http://www.nongnu.org/chmspec/latest/ITSF.html),
  [Internal](http://www.nongnu.org/chmspec/latest/Internal.html),
  [Storage](http://www.nongnu.org/chmspec/latest/Storage.html)
- Matthew Russotto — [CHM format notes](http://www.russotto.net/chm/chmformat.html)
- Microsoft [MS-PATCH] LZX DELTA Compression specification
