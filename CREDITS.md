# Credits / third-party assets

Attribution registry for third-party assets bundled in this repository. Each
entry records the asset, its author, license, and the source it was obtained
from (plus the date added). Assets under a license that requires attribution
(such as the SIL Open Font License) must keep their license file shipped
alongside the asset and stay listed here.

## Fonts (self-hosted, server/public/fonts/)

The viewer/catalog web UI self-hosts two open fonts instead of calling a font
CDN, so the tool works on isolated networks and leaks no request to a third
party. Both are SIL Open Font License 1.1; the full license text ships next to
the font files and must not be removed.

### Atkinson Hyperlegible

- Use: UI body text (chosen for maximum legibility).
- Author / copyright: Copyright 2020 Braille Institute of America, Inc.
- License: SIL Open Font License, Version 1.1 - server/public/fonts/OFL-Atkinson-Hyperlegible.txt
- Source: Google Fonts (https://fonts.google.com/specimen/Atkinson+Hyperlegible) / upstream https://github.com/googlefonts/atkinson-hyperlegible
- Files: server/public/fonts/atkinson-hyperlegible-regular.woff2, atkinson-hyperlegible-bold.woff2 (Latin subset, woff2)
- Added: 2026-06-15

### JetBrains Mono

- Use: monospace log/code blocks.
- Author / copyright: Copyright 2020 The JetBrains Mono Project Authors.
- License: SIL Open Font License, Version 1.1 - server/public/fonts/OFL-JetBrainsMono.txt
- Source: upstream https://github.com/JetBrains/JetBrainsMono / Google Fonts (https://fonts.google.com/specimen/JetBrains+Mono)
- Files: server/public/fonts/jetbrains-mono-regular.woff2, jetbrains-mono-bold.woff2 (Latin subset, woff2)
- Added: 2026-06-15
