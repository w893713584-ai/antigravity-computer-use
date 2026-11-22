# Third-Party Notices

This project incorporates or integrates with the following third-party open-source components and references:

---

## Bundled Dependency: `acorn`

- **Location**: `native/ScriptRunner/vendor/acorn.js`
- **Project**: https://github.com/acornjs/acorn
- **License**: MIT License

```text
MIT License

Copyright (C) 2012-2022 by various contributors (see AUTHORS)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Runtime Optional Dependency: `open-computer-use`

- **Project**: https://github.com/iFurySt/open-computer-use
- **License**: MIT License (`Copyright (c) 2026 Leo`)
- **Integration**: Installed optionally via npm (`open-computer-use@^1.1.3`) or reused from an existing local installation at runtime; not vendored directly into this source repository.

```text
MIT License

Copyright (c) 2026 Leo

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

Per `open-computer-use`'s `THIRD_PARTY_NOTICES.md`, its underlying macOS driver builds upon:
- `trycua/cua` (https://github.com/trycua/cua) — MIT License (`Copyright (c) 2025 Cua AI, Inc.`)
- `asmvik/yabai` (https://github.com/asmvik/yabai) — MIT License (`Copyright (c) 2019 Åsmund Vikane`)
- `libwebp` — BSD-3-Clause License (`Copyright (c) 2010, Google Inc. All rights reserved.`)

---

## Design Inspiration: `vercel-labs/agent-desktop`

- **Project**: https://github.com/vercel-labs/agent-desktop
- **License**: Apache License 2.0
- **Scope**: Headless macOS `AXSelectedText` insertion and `AXScrollBar` semantic scroll fallback in `src/headless-engine.mjs` were inspired by `agent-desktop`'s `type_text.rs` and `scroll.rs` and implemented independently in JavaScript.
