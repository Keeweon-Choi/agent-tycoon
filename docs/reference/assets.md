# Asset system and legacy tileset pipeline

> Read before touching sprites, the furniture catalog, floor/wall tiles, colorize, character sheets or asset loading; also for importing third-party tilesets.

## Asset System

**Loading**: `esbuild.js` copies `webview-ui/public/assets/` → `dist/assets/`. Loader checks bundled path first, falls back to workspace root. PNG → pngjs → SpriteData (2D hex array, alpha≥2 = visible, `#RRGGBBAA` for semi-transparent). `loadDefaultLayout()` reads `assets/default-layout.json` as fallback for new workspaces.

**Catalog**: `furniture-catalog.json` with `id, name, label, category, footprint, isDesk, canPlaceOnWalls, groupId?, orientation?, state?, canPlaceOnSurfaces?, backgroundTiles?`. String-based type system. Categories: desks, chairs, storage, electronics, decor, wall, misc. Wall-placeable items use the `wall` category and appear in a dedicated "Wall" tab. Asset naming convention: `{BASE}[_{ORIENTATION}][_{STATE}]` (e.g., `MONITOR_FRONT_OFF`).

**Per-furniture manifests**: Each furniture item lives in its own folder under `assets/furniture/` with a `manifest.json` that declares its sprites, rotation groups, state groups (on/off), and animation frames. Floor tiles are individual PNGs in `assets/floors/`; wall tile sets in `assets/walls/`.

**Redrawn furniture (cld-gui CH-6b)**: in the layout editor a selected placed item offers 그림 고치기 (`webview-ui/src/cld/furniture/FurnitureArt.tsx`, the CH-6 `PixelEditor` with `art`). A save POSTs `/cld/furniture {base, png}`; `server/src/cld/customFurniture.ts` checks the PNG header against the original's sprite size before decoding, picks the id `custom-<base>-<time>` and writes `<id>.png` plus a manifest it builds from the original's catalog fields into `~/.config/cld-gui/furniture/<id>/` (0700/0600, write-then-rename), which `cli.ts` always loads (`loadAllFurniture(..., customDir)`) and re-broadcasts. One orientation, one state: a redrawn item does not rotate or toggle. `DELETE /cld/furniture/<id>` removes only custom folders; placed copies then render like any missing asset. Floors and walls are not redrawable (their colour sliders cover them).

**Rotation groups**: `buildDynamicCatalog()` builds `rotationGroups` Map from assets sharing a `groupId`. Supports 2+ orientations (e.g., front/back only). Editor palette shows 1 item per group (front orientation preferred). `getRotatedType()` cycles through available orientations.

**State groups**: Items with `state: "on"` / `"off"` sharing the same `groupId` + `orientation` form toggle pairs. `stateGroups` Map enables `getToggledType()` lookup. Editor palette hides on-state variants. State groups are mirrored across orientations.

**Auto-state**: `officeState.rebuildFurnitureInstances()` swaps electronics to ON sprites when an active agent faces a desk with that item nearby (3 tiles deep in facing direction, 1 tile to each side). Operates at render time without modifying the saved layout.

**Background tiles**: `backgroundTiles?: number` — top N footprint rows allow other furniture to be placed on them AND characters to walk through. Z-sort places bg-row items behind the host furniture.

**Surface placement**: `canPlaceOnSurfaces?: boolean` — items like laptops, monitors, mugs can overlap with all tiles of `isDesk` furniture. `canPlaceFurniture()` builds a desk-tile set and excludes it from collision checks. Z-sort: surface items get `zY = max(spriteBottom, deskZY + 0.5)`.

**Wall placement**: `canPlaceOnWalls?: boolean` — items like paintings, windows, clocks can only be placed on wall tiles. `canPlaceFurniture()` requires the bottom row of the footprint to be on wall tiles; upper rows may extend above the map. `getWallPlacementRow()` offsets placement so the bottom row aligns with the hovered tile.

**Colorize module**: `colorize.ts` with two modes selected by `ColorValue.colorize?` flag. **Colorize mode** (Photoshop-style): grayscale → luminance → contrast → brightness → fixed HSL; always used for floor tiles. **Adjust mode** (default for furniture and character hue shifts): shifts original pixel HSL. `adjustSprite()` exported for character hue shifts. Cache keyed by arbitrary string (includes colorize flag).

**Floor tiles**: `floors.png` (112×16, 7 patterns). Cached by (pattern, h, s, b, c).

**Wall tiles**: `walls.png` (64×128, 4×4 grid of 16×32 pieces). 4-bit auto-tile bitmask (N=1, E=2, S=4, W=8). Sprites extend 16 px above tile (3D face). `wallTiles.ts` computes bitmask at render time. Colorizable via HSBC sliders. Wall sprites z-sorted with furniture/characters (`getWallInstances()` builds `FurnitureInstance[]`).

**Character sprites**: 6 pre-colored PNGs (`assets/characters/char_0.png`–`char_5.png`), one per palette. Each 112×96: 7 frames × 16 px wide, 3 direction rows × 32 px tall. Row 0 = down, Row 1 = up, Row 2 = right. Frame order: walk1, walk2, walk3, type1, type2, read1, read2. Left = flipped right at runtime. When `hueShift !== 0`, `hueShiftSprites()` applies `adjustSprite()` to all frames before caching.

**People made of parts (cld-gui CHAR-HUMAN)**: a v3 look `{v: 3, kind: 'person', gender?, parts: {body, face, bottom, shoes, top, outer, hair, acc[]}, colors}` is composed by `webview-ui/src/cld/characters/parts.ts` from parts in that layer order, then the reading paper (and the built-in reading glasses unless an `acc` part's id says glasses). A part is `sheet` (112×96 on the body grid) or `head` (front/back/side on the 16×24 head canvas, placed at each frame's head anchor); its `ramp` colours recolour with shading kept (`rampColours`, shared with `recolourSheet`). Built-in parts (the bald body `basic`, two faces, the six built-ins split by their region maps), the head anchors and the paper are generated into `core/src/cld/parts.generated.ts` by `cld/scripts/gen-char-templates.ts`, which also draws the owner's templates (`cld/artifacts/char-parts/templates/`, guide `cld/docs/design/char-parts.md`). The owner's drawings go through `server/src/cld/partImport.ts` (assetSnap, magenta and green mannequin removed, aligned by the mannequin) into `~/.config/cld-gui/parts/p-<slot>-<name>/part.json` (`characterParts.ts`: routes `/cld/parts*`, the `characterParts` message, named looks in `presets.json`); `partImportCli.ts` imports a folder. Unknown part ids draw as the slot's built-in; v1/v2 looks are untouched.

**Character factory (cld-gui CHAR-FACTORY)**: `core/src/cld/partRegistry.ts` is the slot/layer registry (back, body, face, legwear, bottom, shoes, top, fullbody, outer, neck, wrist, hair, acc; layer order per view, `fullbody` clears top/bottom, eight face expressions, body variants standard/slim/curvy/plus and which fit standard art); the compositor, importer, daemon check and looks window read it, so a costume is data. Parts may carry `hd` (density 2: 32×64 frames, same world size; classic parts drawn ×2 nearest in an HD look; `classicOf()` is the 2×2 fallback), `expressions`, `bodies`/`variants`. Content packs: `cld/packs/<id>/pack.json` (built in: only what the owner sent up to 10-25; esbuild copies them to `dist/packs/`) and `~/.config/cld-gui/packs/<id>/` (the user's expansion packs; their sources live in the git-ignored `packs-private/`, never in the repo), loaded by `server/src/cld/packs.ts` (ids `<pack>/<part>`, every pack on; old `adultOnly`/`defaultEnabled`/`adultOriginal` keys are read past). The presets folder also takes HD sheets (224×192, `density: 2`); `cld/scripts/convert-hd-sheet.ts` turns a generator's labelled box sheet into one, through `server/src/cld/pixelResample.ts` (the art's own grid or the fit size, foreground-share sampling with the outline kept, holes and specks cleaned), which the importer's HD crop shares; `cld/scripts/measure-hd-convert.ts` measures it.

**Load order**: `characterSpritesLoaded` → `floorTilesLoaded` → `wallTilesLoaded` → `furnitureAssetsLoaded` → `layoutLoaded`.

## Asset Pipeline (legacy tileset import)

7-stage pipeline in `scripts/` for importing third-party tilesets (the bundled assets don't need this):

1. `0-import-tileset.ts` — Interactive CLI wrapper
2. `1-detect-assets.ts` — Flood-fill asset detection
3. `2-asset-editor.html` — Browser UI for position/bounds editing
4. `3-vision-inspect.ts` — Claude vision auto-metadata
5. `4-review-metadata.html` — Browser UI for metadata review
6. `5-export-assets.ts` — Export PNGs + `furniture-catalog.json`
7. `asset-manager.html` — Unified editor (stages 2+4 combined), Save/Save As via File System Access API

Supporting: `wall-tile-editor.html` (wall sprite editing), `jsonl-viewer.html` (transcript inspector).
