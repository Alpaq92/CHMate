# Credits & licenses

CHMate is MIT-licensed. Everything it ships is permissively licensed; nothing
here is GPL/LGPL.

| Part | Origin | License |
| --- | --- | --- |
| ITSS/ITSF container parser (`src/chm/itsf.js`, `byte-reader.js`) | Own implementation, written against the [chmspec](http://www.nongnu.org/chmspec/latest/) and [Russotto's notes](http://www.russotto.net/chm/chmformat.html) | MIT |
| Content resolution, ResetTable/ControlData (`src/chm/content.js`) | Own implementation | MIT |
| `#SYSTEM` / `#WINDOWS`, sitemap (`.hhc`/`.hhk`), encoding, reader API | Own implementation | MIT |
| **LZX decompressor** (`src/chm/lzx.js`) | Ported to JS from [mlocati/chm-lib](https://github.com/mlocati/chm-lib) | MIT |
| Browser UI, sanitizer, renderer (`index.html`, `css/`, `src/app.js`, `src/render.js`) | Own implementation | MIT |
| Demo file (`samples/putty.chm`) | PuTTY documentation © Simon Tatham et al. | PuTTY (MIT-style) — see `samples/putty.chm.LICENCE` |

## LZX decoder lineage

The hardest part of reading CHM is LZX decompression. CHMate's `lzx.js` is a
faithful JavaScript port of the decompressor in **mlocati/chm-lib** (PHP, MIT,
© 2016 Michele Locati). Per that project's license notice:

> The algorithm used to decompress the LZX data is — for the most part — taken
> from the CHMPane project, and I've had the written permission to reuse it in
> this CHMLib Project by Rui Shen to publish it under MIT License.

The canonical-Huffman `makeSymbolTable` routine within it was originally coded
by David Tritscher. CHMate carries the same MIT terms; see the header comment
in `src/chm/lzx.js` and the THIRD-PARTY NOTICES in `LICENSE`.

## Specifications & references (no code used)

- chmspec — [ITSF](http://www.nongnu.org/chmspec/latest/ITSF.html),
  [Internal](http://www.nongnu.org/chmspec/latest/Internal.html),
  [Storage](http://www.nongnu.org/chmspec/latest/Storage.html)
- Matthew Russotto — [CHM format notes](http://www.russotto.net/chm/chmformat.html)
- Microsoft [MS-PATCH] LZX DELTA Compression specification
