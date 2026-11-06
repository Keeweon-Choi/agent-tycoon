# Galmuri (Hangul pixel font)

Galmuri11.woff2 from Galmuri v2.40.4 by quiple (Lee Minseo),
https://github.com/quiple/galmuri, release asset `Galmuri-v2.40.4.zip`,
SIL Open Font License 1.1 (see OFL.txt).

The 11 px face (all 11,172 Hangul syllables), used for Hangul only
(`unicode-range` in `webview-ui/src/fonts.css`); Latin stays FS Pixel Sans.
It is drawn at `size-adjust: 66.667%` so Hangul sits next to FS Pixel Sans's
small Latin at a similar size: one font pixel is then exactly 1 CSS px at 18 px
text (and 2 at 36 px). Galmuri's em is 12 font pixels (design size 11 + 1).

FIX-PHONE-UI-TEXT (11-06): the file here is not the release's own WOFF2 but its
`Galmuri11.ttf` (sha256 e24256f4...def1) repacked by
`node scripts/woff2-untransformed.mjs Galmuri11.ttf Galmuri11.woff2`: the same tables with
no glyf/loca transform. WebKit's WOFF2 decoder refuses the release's transformed files
(every Galmuri .woff2: `FontFace.load()` rejects with a NetworkError), so in Safari the
Hangul fell back to FS Pixel Sans's .notdef boxes; this file loads in WebKit, Chromium
and Firefox (533 KB instead of 505 KB). Repack again when updating Galmuri.
