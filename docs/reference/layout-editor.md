# Layout editor

> Read before touching the layout editor tools, furniture placement, undo/redo, grid expansion or the layout model.

## Layout Editor

Toggle via "Layout" button. Tools: SELECT (default), Floor paint, Wall paint, Erase (set tiles to VOID), Furniture place, Furniture Copy (`FURNITURE_PICK`: type + colour off a placed item), colour Copy (`COLOR_PICK`: colour only), Eyedropper (floor/wall). `handleEditorTileAction` is a per-tool switch; the layout maths lives in pure `editorActions.ts` functions. Clicks on placed items (select, drag) never reach it — the canvas resolves them.

**Floor**: 7 patterns from `floors.png` (grayscale 16×16), colorizable via HSBC sliders (Photoshop Colorize). Color baked per-tile on paint. Eyedropper picks pattern+color.

**Walls**: Separate Wall paint tool. Click/drag to add walls; click/drag existing walls to remove (toggle direction set by first tile of drag, tracked by `wallDragAdding`). HSBC color sliders (Colorize mode) apply to all wall tiles at once. Eyedropper on a wall tile picks its color and switches to Wall tool. Furniture cannot be placed on wall tiles, but background rows may overlap walls.

**Furniture**: Ghost preview (green/red validity); `buildEditorRenderState` (`office/editor/`) builds the frame's `ghosts[]` + one `ghostValid`. R key rotates, T key toggles on/off state — a selected placed item wins over the catalog type. Drag-to-move in SELECT; **Alt-drag drops a copy** (cursor `copy`, Alt sampled live so it can flip mid-drag; the copy is left selected). The canvas only reports the gesture (`onDrop(uid, col, row, { duplicate })`); `handleDrop` → pure `dropFurniture` validates, commits and sets selection. **Desks carry their riders**: surface items standing on an `isDesk` item (`getSurfaceRiders`) move, rotate (spot swung round the desk top) and get copied with it; the whole group must fit or nothing happens. Delete button (red X) + rotate button (blue arrow) on selected items. **Selecting a placed item closes the open tool tab and opens its HSBC colour sliders** (Reset + Copy buttons); color stored per-item in `PlacedFurniture.color?`. Hit-testing is ONE `furnitureAt` (surface items win over the desk under them) — select, drag, cursor and both Copy tools agree. Placement state is `editorState.placing: { type, color? }`: the Copy tool's lifted colour styles that copy only — `color: null` is a copied ABSENCE of colour, so an uncoloured item's copy stays uncoloured under a palette colour; `undefined` (a plain catalog pick) takes `pickedFurnitureColor` (`placementColor()`); palette sliders override either. Colour Copy takes the clicked item's colour into whichever sliders armed it, then returns to that tool.

**Undo/Redo**: 50-level, Ctrl+Z/Y. EditActionBar (top-center when dirty): Undo, Redo, Save, Reset. **Stroke-scoped undo**: every edit goes through `commitLayout(layout, session)`; edits sharing `editorState.undoSession` collapse into one entry — `'stroke'` (one floor / wall / erase / carpet click-drag), `'wallColor'`, `` `color:<uid>` `` (a slider run on one item). `null` = discrete edit (its own entry; a colour eyedrop is one). Mouse up / leave, tool change, Esc, selection changes and undo/redo end the session (`endStroke`). Area paint stays per-tile.

**Multi-stage Esc**: exit furniture pick → deselect catalog → close tool tab → deselect furniture → close editor.

**Erase tool**: Sets tiles to `TileType.VOID` (transparent, non-walkable, no furniture) **and deletes any furniture whose footprint the stroke passes through** (`removeFurnitureAt`). Right-click in floor/wall/erase tools also erases to VOID + furniture (drag-erasing supported). Context menu suppressed in edit mode.

**Grid expansion**: In floor/wall/erase tools, a ghost border (dashed outline) appears 1 tile outside the grid. Clicking a ghost tile calls `expandLayout()` to grow the grid by 1 tile in that direction. New tiles are VOID. Furniture positions and character positions shift when expanding left/up. Max: `MAX_COLS`×`MAX_ROWS` (64×64). Default: `DEFAULT_COLS`×`DEFAULT_ROWS` (20×11). Characters outside bounds after resize relocated to random walkable tiles.

**Layout model**: `{ version: 1, cols, rows, tiles: TileType[], furniture: PlacedFurniture[], tileColors?: ColorValue[] }`. Grid dimensions are dynamic. Persisted via debounced saveLayout message → `writeLayoutToFile()` → `~/.pixel-agents/layout.json`.
