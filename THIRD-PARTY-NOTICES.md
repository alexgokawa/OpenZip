# Third-party notices

OpenZip's own source code is released under the MIT License (see `LICENSE`).
OpenZip also ships two unmodified third-party programs in `bin/`. Each is a
separate program that OpenZip starts as a child process through its command
line. They are not linked into OpenZip and keep their own licenses.

## SCS Extractor (`bin/extractor.exe`)

- Project: **Extractor** by sk-zk, version **2026.07.29**
- Source code: <https://github.com/sk-zk/Extractor>
- License: **GNU General Public License v2.0** (full text in `licenses/GPL-2.0.txt`)
- Built on the TruckLib.HashFs library (version 0.2.6) by the same author,
  which is compiled into the executable.
- The executable is shipped unmodified. Its complete corresponding source code
  is available at the link above, and any version of it can be rebuilt from
  there with the .NET SDK.
- Using the GPL-licensed extractor as a separate command-line program does not
  place OpenZip's own code under the GPL.

OpenZip is not affiliated with or endorsed by sk-zk.

## 7-Zip (`bin/7z/7z.exe`, `bin/7z/7z.dll`)

- Project: **7-Zip 24.09**, Copyright (C) 1999-2024 Igor Pavlov
- Website: <https://www.7-zip.org>
- License: GNU LGPL, with the unRAR license restriction for some code, and BSD
  2-clause and 3-clause licenses for other code. Full terms are in
  `bin/7z/License.txt`.
- unRAR restriction: the RAR decompression code may not be used to re-create
  the proprietary RAR compression algorithm or to develop a RAR (WinRAR)
  compatible archiver. OpenZip only reads and extracts RAR archives.
- The executables are shipped unmodified.

## npm dependencies

OpenZip is built with Electron, React, Vite, Monaco Editor, node-7z, adm-zip,
7zip-bin and Lucide. Each keeps its own license (MIT, BSD, Apache-2.0 or
similar); see each package's license in `node_modules` after `npm install`.
The packaged Electron app also includes the Electron and Chromium license
files that electron-builder adds to the installer.
