# License scope and release boundary

The MIT license covers this project's original software and geometric SVG theme
(`src/theme/atelier.ts`, the default resource icons and project-authored UI shapes),
to the extent the contributors hold the relevant rights. Upstream card-data
attribution is retained in THIRD_PARTY_NOTICES.md.

Third-party names and references identify the game being studied. No license to
third-party trademarks, characters, official artwork, written rulebooks or other
protected expression is granted. This is an unofficial educational project,
not an endorsed product. A copyright notice or a noncommercial intention does
not independently establish permission for third-party material.

Local private themes and environment files are excluded from Git and release
archives. In this workspace that includes `src/theme/local/` and
`public/art/eva/`. Do not use `git add -f` on them or upload a local build
containing them. Public release builds must be made from a clean tracked export.

The public project uses MIT, which allows commercial use of licensed code.
Do not describe it as a "noncommercial-only open-source license".
Third-party assets must be replaced or separately authorized for any distribution.

Reference sources, checked 2026-11-13:
- MIT: https://choosealicense.com/licenses/mit/
- Open Source Definition: https://opensource.org/osd
- Evangelion fan-work publication guideline: https://www.khara.co.jp/guideline/
  Its stated categories and conditions are not treated as blanket authorization
  to distribute a game or to sublicense franchise material under MIT.
