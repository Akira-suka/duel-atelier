# Third-party notices

The public distribution uses original geometric SVG artwork. Local franchise fan themes are not included. See ASSET_POLICY.md for license scope.

## Card statistics

The base-game card statistics in `src/game/catalog.ts` are adapted from
[dylanguo1129/splendor-duel-ai/data/cards.json](https://github.com/dylanguo1129/splendor-duel-ai/blob/main/data/cards.json),
retrieved on 2026-11-13. The full upstream MIT license was retrieved and is reproduced below.
The downloaded JSON has SHA-256
`cedd5f2b0a97828aee0b5fe4c2c1dc8edbc7e7911dce8b50630c9a1bf714b1cc`.

The data was normalized into named colors and effects, preserving source level/index as
IDs `j1-01` through `j3-13`. It contains 30 level-one, 24 level-two and 13 level-three
jewel cards, plus four royal cards. Copy-color bonuses are represented separately from
immediate effects. Cards with no bonus remain colorless.

### Verification and known source conflicts

All 67 jewel-card records were compared to the complete card-face reference sheets
[`cards1.jpg`](https://github.com/BalthazarW/splendor-duel/blob/main/assets/cards1.jpg),
[`cards2.jpg`](https://github.com/BalthazarW/splendor-duel/blob/main/assets/cards2.jpg), and
[`cards3.jpg`](https://github.com/BalthazarW/splendor-duel/blob/main/assets/cards3.jpg).
The comparison covered costs, points, crowns, bonus colors/counts and ability symbols.
The four royal cards were checked against the corresponding
[`royal_cards/card-1.png` through `card-4.png`](https://github.com/BalthazarW/splendor-duel/tree/main/assets/royal_cards)
images: steal, extra turn and privilege each award two points; the ability-free royal
awards three points.
These third-party reference images are not an official publisher dataset; this check
does not establish independent verification against a physical retail copy.

The second implementation's
[`cards.data`](https://github.com/BalthazarW/splendor-duel/blob/main/data/cards.data)
agrees with 62 records after normalization, but incorrectly assigns two crowns to
each of the five level-three four-point colored jewels. The reference card faces show
zero crowns, matching the imported MIT data and this project's table.

The eight-red level-three copy-color card (`j3-11`) was also checked against its face:
it grants three prestige points, zero crowns, one copy-color bonus and an extra turn.
The differing zero-point/one-crown entry in
[`theguega/OOP-Board-Game`](https://github.com/theguega/OOP-Board-Game/blob/master/source/data/data_carte.sql)
was not adopted. No code or table from either C++ project is incorporated here.

Card-face images were used only as temporary visual references for the statistics
audit. The application ships project-authored CSS card layouts and original geometric SVG illustrations, without packaging official Splendor Duel or Evangelion
commercial card images, extracted logos, font files or copied rules prose. Splendor
Duel and the original game artwork belong to their respective owners. This is an
unofficial local implementation.

### Upstream MIT license

MIT License

Copyright (c) 2026 dylanguo1129

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

## React, React DOM and Scheduler

The prebuilt browser bundle includes these MIT-licensed runtime libraries. Their shared license text follows:

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

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

