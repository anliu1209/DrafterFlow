# Third Party Notices

This project acknowledges and incorporates the following third-party software.

## bekuto3d (MIT)

The potrace-based vectorization approach used in this project's `vectorize.py`
is informed by and acknowledges:

- bekuto3d — <https://github.com/LittleSound/bekuto3d>
- Copyright (c) 2025-PRESENT **Rizumu** (<https://github.com/LittleSound>)

Licensed under the **MIT License**:

```
MIT License

Copyright (c) 2025-PRESENT Rizumu (https://github.com/LittleSound)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## potracer (GPLv2+)

This project depends on `potracer`, a pure-Python port of Potrace:

- potracer — <https://github.com/tatarize/potrace>
- License: **GNU General Public License v2 or later** (GPLv2+)

The original Potrace (<https://potrace.sourceforge.net>, by Peter Selinger) is
also GPL-licensed.

> **IMPORTANT — copyleft**: because `potracer` is GPL, any *distribution* of
> this project (publishing source or binaries) must be under a **GPL-compatible
> license** and include the full corresponding source and the GPL license text.
> Hosting the app for internal/private use does not by itself trigger this. If
> you plan to distribute, choose a GPL-compatible license for the project, or
> replace `potracer` with a permissively-licensed alternative (e.g. a sub-pixel
> marching-squares tracer such as scikit-image's `find_contours`, which is BSD).
