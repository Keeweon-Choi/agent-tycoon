import type { CharacterChoice } from '../../core/src/messages.js';
import type { Framing } from './cld/cameraMode.js';
import { compose } from './cld/characters/compose.js';
import { getCustomParts, presetPalette } from './cld/characters/looks.js';
import { chatOpenFor } from './cld/chat.js';
import { nameplateStats } from './cld/ez/useNameplates.js';
import { floorsSnapshot } from './cld/floors.js';
import {
  isoCarLevel,
  isoCharacterBox,
  isoFloors,
  isoFrame,
  isoScreenAt,
  isoStats,
} from './cld/iso/render.js';
import { cldGetSnapshot } from './cld/officeStore.js';
import { otherFloorStats } from './cld/otherFloors.js';
import { perfSnapshot, setPerfOn } from './cld/perf.js';
import type { ColorValue } from './components/ui/types.js';
import { OfficeState } from './office/engine/officeState.js';
import { isGhostHeadlessAgentsEnabled } from './office/engine/renderer.js';
import { isWalkable } from './office/layout/tileMap.js';
import { carpetJunctionCase } from './office/sprites/carpetTiles.js';
import { smoothCacheBytes, warmPending } from './office/sprites/smoothSprite.js';
import { getCachedSprite } from './office/sprites/spriteCache.js';
import {
  getCharacterSprites,
  getCharacterTemplates,
  setCustomCharacter,
  spritesAtZoom,
} from './office/sprites/spriteData.js';

declare global {
  interface Window {
    __pixelAgentsTestHooks?: {
      playedSounds?: Array<{ kind: string; at: number }>;
      getCharacters?: () => Array<{
        id: number;
        matrixEffect: 'spawn' | 'despawn' | null;
        agentName?: string;
        bubbleType: 'permission' | 'waiting' | null;
        waitingAwaitingInput?: boolean;
        isHeadless?: boolean;
        isGreeter?: boolean;
      }>;
      /** The character the camera follows (null = free camera). */
      getCameraFollowId?: () => number | null;
      /** Effective "Display headless as ghosts" setting the renderer is using. */
      getGhostHeadlessAgents?: () => boolean;
      getOtherFloorStats?: () => { renders: number; ms: number };
      /** charpack v3 §6A: the nameplate overlap passes so far, their total and worst ms, the plates of the last. */
      getNameplateStats?: () => { passes: number; ms: number; maxMs: number; plates: number };
      /** Is character `id`'s conversation or terminal on screen (notices treat it as looked at). */
      chatOpenFor?: (id: number) => boolean;
      // ── Carpet + Areas observability (added for carpet/areas e2e) ──
      /** Sparse list of painted carpet tiles with their grid coords. */
      getCarpetTiles?: () => Array<{
        col: number;
        row: number;
        variant: number;
        color?: ColorValue;
        accentColor?: ColorValue;
        order?: number;
      }>;
      /** 4-bit marching-squares case for a junction (NW=1,NE=2,SE=4,SW=8) via the
       *  real renderer logic — for asserting carpet autotiling. */
      getCarpetJunctionCase?: (jx: number, jy: number, variant: number) => number;
      /** Area definitions in the current layout. */
      getAreas?: () => Array<{ label: string; color: string }>;
      /** Sparse list of area-painted tiles with their grid coords. */
      getAreaTiles?: () => Array<{ col: number; row: number; label: string }>;
      /** Directory→Area mappings received by OfficeState. */
      getAreaMappings?: () => Record<string, string[]>;
      /** Effective show-areas gate (settings toggle OR active area edit). */
      getShowAreas?: () => boolean;
      /** Count of placed furniture instances — lets a spec assert furniture
       *  placed onto a carpet tile (surface placement) without it being blocked. */
      getFurnitureCount?: () => number;
      /** The layout's tile grid — lets a spec assert floor paint / erase (which
       *  render only on the canvas) and that one undo reverts a whole stroke. */
      getTiles?: () => { cols: number; rows: number; tiles: number[] };
      /** Placed furniture with grid coords, so a spec can assert exactly which
       *  item an erase stroke removed (getFurnitureCount only gives a total). */
      getFurniture?: () => Array<{
        uid: string;
        type: string;
        col: number;
        row: number;
        color?: ColorValue;
      }>;
      /** Seated top-level agents with the area their seat falls in (or null). */
      getAgentSeats?: () => Array<{
        id: number;
        seatId: string | null;
        areaLabel: string | null;
        directoryName?: string;
      }>;
      /** All seats with grid coords + the area their tile falls in — lets a spec
       *  paint an Area over a known seat without hardcoding layout coordinates. */
      getSeats?: () => Array<{
        uid: string;
        col: number;
        row: number;
        areaLabel: string | null;
        assigned: boolean;
      }>;
      /** Drive the real edit-mode tile paint/erase handlers by (col,row),
       *  bypassing only canvas pixel→tile geometry (mirrors petClick). */
      editorTileAction?: (col: number, row: number) => void;
      editorEraseAction?: (col: number, row: number) => void;
      /** Release a furniture drag at (col,row) via the real drop handler (a copy
       *  with `duplicate`, as Alt does) — skips the whole mouse gesture: press,
       *  movement, the Alt modifier and pixel→tile geometry. The drop rules
       *  themselves (group validity, riders, selection) still run. */
      editorDrop?: (uid: string, col: number, row: number, duplicate?: boolean) => void;
      /** Centre of tile (col,row) in CSS pixels relative to the office canvas,
       *  through the renderer's own projection (zoom + pan) — lets a spec drive
       *  the REAL canvas mouse gesture at a known tile. Null before mount. */
      getTileCenter?: (col: number, row: number) => { x: number; y: number } | null;
      getPets?: () => Array<{
        id: string;
        name: string;
        petType: number;
        state: 'idle' | 'walk' | 'follow';
        x: number;
        y: number;
        bubbleType: 'heart' | null;
      }>;
      petClick?: (petId: string) => void;
      addAgentLog?: Array<{
        id: number;
        skipSpawnEffect: boolean | undefined;
        matrixEffectAtCreation: 'spawn' | 'despawn' | null;
      }>;
      messageLog?: Array<{
        at: number;
        type: string;
        id?: number;
        toolName?: string;
        status?: string;
        toolId?: string;
        parentToolId?: string;
      }>;
      selectAgent?: (id: number) => void;
      /** Where a character stands (T-0048): its tile, state and queued steps. */
      getCharacterTile?: (id: number) => {
        col: number;
        row: number;
        state: string;
        queued: number;
        active: boolean;
        away: boolean;
        /** ELEVATOR: its ride's phase and whether the car hides it; the floor it visits. */
        ride: string | null;
        /** Seconds in that phase. */
        rideT: number | null;
        hidden: boolean;
        visit: string | null;
      } | null;
      /** ELEVATOR: each floor's elevator (its wall tiles' left one) and how open its doors are. */
      getElevators?: () => Array<{ floor: string; col: number; row: number; open: number }>;
      /** Pixel position for rAF-sampled keyboard-walk checks (T-0061). */
      getCharacterPosition?: (id: number) => { x: number; y: number } | null;
      /** 2.5D PILOT: walk a character to a tile, as the right-click command does. */
      walkAgentTo?: (id: number, col: number, row: number) => boolean;
      /** Whether pathfinding may stand on a tile (walls, furniture, seats, edges say no). */
      isTileWalkable?: (col: number, row: number) => boolean;
      /** The selected agent's id (null = none). */
      getSelectedAgentId?: () => number | null;
      /** GFX: give character `id`'s look a synthetic HD sheet (density 2: its own sheet doubled,
       *  with one white sprite px at (15, 41) of every frame, half a world px). */
      makeHdCharacter?: (id: number) => boolean;
      /** GFX: draw one more item at (col,row), on this page only (not saved): a 2.5D test object. */
      placeFurniture?: (type: string, col: number, row: number) => boolean;
      /** HD64-SAMPLE: set the zoom (Classic camera: it stays), and pan a character to the middle. */
      setZoom?: (zoom: number) => void;
      centerOn?: (id: number) => boolean;
      /** HD64-SAMPLE: `n` characters (ids from `firstId`) wearing `look`, each its own look (a
       *  person's suit in another colour, the next built-in body), so each composes and caches
       *  its own sheet; returns their palettes. */
      spawnLook?: (look: CharacterChoice, n: number, firstId: number) => number[];
      /** HD64-SAMPLE: building the sprite cache of palette/hue at `zoom` (ms, 21 frames and the
       *  mirrored left ones), measured once (later calls hit the cache). */
      cacheBuildMs?: (palette: number, hue: number, zoom: number) => number;
      /** SHEET-IMPORT: `n` characters (ids from `firstId`) wearing preset `id` (its palette once
       *  loaded; -1 while it loads), every other one typing at a desk. */
      spawnPreset?: (id: string, n: number, firstId: number) => number;
      /** SHEET-IMPORT: select and follow character `id` (what a click on it does). */
      follow?: (id: number) => void;
      /** SHEET-IMPORT: character `id` at its desk (`tool`: what it works with, Read reads) or not. */
      setActive?: (id: number, on: boolean, tool?: string | null) => void;
      /** SHEET-IMPORT: pictures still queued to warm, and the bytes the zoom LRU holds. */
      warmState?: () => { pending: number; bytes: number };
      /** HD64-SAMPLE: walk character `id` to a tile (false: no path). */
      walkTo?: (id: number, col: number, row: number) => boolean;
      /** HD64-SAMPLE: the density palette/hue draws at `zoom` (its LOD there). */
      drawnDensity?: (palette: number, hue: number, zoom: number) => number;
      /** HD64-SAMPLE: the performance readout's numbers (and turning it on). */
      perf?: () => ReturnType<typeof perfSnapshot>;
      setPerf?: (on: boolean) => void;
      /** ISO-PILOT: the isometric view's counters, the floor in focus, the car's level. */
      getIso?: () => {
        groundRenders: number;
        dimRenders: number;
        frames: number;
        ms: number;
        focus: string;
        building: boolean;
        car: number;
        drawn: boolean;
        floors: Array<{ id: string; row: number; rows: number; level: number }>;
      };
      /** ISO-PILOT: CSS px (in the canvas) where the building drew world point (x, y). */
      isoPoint?: (worldX: number, worldY: number) => { x: number; y: number } | null;
      /** ISO-PILOT: a character's box as the last frame drew it, CSS px of the canvas. */
      isoCharacterBox?: (id: number) => { x: number; y: number; w: number; h: number } | null;
      /** GFX: the camera now (zoom, pan) and the map it frames. */
      getCamera?: () => {
        zoom: number;
        pan: { x: number; y: number };
        cols: number;
        rows: number;
        framing: Framing | null;
      };
    };
  }
}

/**
 * Install e2e test observables on window.__pixelAgentsTestHooks. Mostly
 * read-only / append-only; the one action (selectAgent) only sets selection
 * state and changes no production logic. Called once at module-load from
 * App.tsx with the singleton officeStateRef.
 *
 * - getCharacters(): point-in-time snapshot of every character's matrix, team, and bubble state.
 * - addAgentLog: append-only history of every OfficeState.addAgent call. The
 *   log captures matrixEffect AT addAgent time (synchronously inside the
 *   wrapper), eliminating the ~300ms matrix-effect lifetime race that would
 *   let a regression slip past a snapshot-based check.
 * - playedSounds: populated separately by notificationSound.ts (same namespace,
 *   different owner).
 * - selectAgent(id): sets officeState.selectedAgentId directly, the same state
 *   a canvas click produces. Lets e2e reveal an agent's "Close agent" (×)
 *   button deterministically instead of pixel-hunting the sprite on the canvas
 *   (see closeAgentFromOverlay in e2e/helpers/office.ts). ToolOverlay reads
 *   selectedAgentId every rAF, so the × button surfaces on the next frame.
 */
/** Palettes the spawned test looks take (past the presets'), the built-in bodies, and the colour
 *  of the i-th spawned suit (round the wheel). */
const SPAWN_PALETTE = 50_000;
const BUILT_IN_BODIES = 6;
const wheel = (i: number) => {
  const h = (i * 47) % 360;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (0.5 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

export function installTestHooks(officeStateRef: { current: OfficeState | null }): void {
  if (typeof window === 'undefined') return;
  if (!window.__pixelAgentsTestHooks) window.__pixelAgentsTestHooks = {};
  const hooks = window.__pixelAgentsTestHooks;
  if (!hooks.addAgentLog) hooks.addAgentLog = [];

  hooks.perf = () => perfSnapshot();
  hooks.getIso = () => ({
    ...isoStats,
    focus: floorsSnapshot().current,
    building: floorsSnapshot().stacked,
    car: isoCarLevel(),
    drawn: isoFrame(),
    floors: isoFloors(),
  });
  hooks.isoCharacterBox = (id) => {
    const b = isoCharacterBox(id);
    const dpr = window.devicePixelRatio || 1;
    return b && { x: b.x / dpr, y: b.y / dpr, w: b.w / dpr, h: b.h / dpr };
  };
  hooks.isoPoint = (wx, wy) => {
    const p = isoScreenAt(wx, wy);
    const dpr = window.devicePixelRatio || 1;
    return p && { x: p.x / dpr, y: p.y / dpr };
  };
  hooks.setPerf = (on) => setPerfOn(on);
  hooks.spawnLook = (look, n, firstId) => {
    const os = officeStateRef.current;
    const palettes: number[] = [];
    for (let i = 0; i < n; i++) {
      // each its own look, as distinct staff are: a person's suit turned round the colour wheel,
      // a built-in body by number
      const own: CharacterChoice =
        look.kind === 'person'
          ? { ...look, colors: { ...look.colors, fullbody: wheel(i) } }
          : { ...look, palette: ((look.palette ?? 0) + i) % BUILT_IN_BODIES };
      const c = compose(own, {
        templates: getCharacterTemplates(),
        provider: null,
        parts: getCustomParts(),
      });
      const palette = SPAWN_PALETTE + firstId + i;
      setCustomCharacter(palette, c.sheet, c.mugshot);
      palettes.push(palette);
      os?.addAgent(firstId + i, palette, 0, undefined, true);
      // every other one at a desk typing, the rest walking about
      os?.setAgentActive(firstId + i, i % 2 === 0);
    }
    return palettes;
  };
  hooks.spawnPreset = (id, n, firstId) => {
    const preset = cldGetSnapshot().characterPresets?.presets.find((p) => p.id === id);
    const palette = preset ? presetPalette(preset) : null;
    if (palette === null) return -1;
    for (let i = 0; i < n; i++) {
      officeStateRef.current?.addAgent(firstId + i, palette, 0, undefined, true);
      officeStateRef.current?.setAgentActive(firstId + i, i % 2 === 0);
    }
    return palette;
  };
  hooks.follow = (id) => {
    const os = officeStateRef.current;
    if (!os) return;
    os.selectedAgentId = id;
    os.cameraFollowId = id;
  };
  hooks.setActive = (id, on, tool = null) => {
    officeStateRef.current?.setAgentActive(id, on);
    officeStateRef.current?.setAgentTool(id, on ? tool : null);
  };
  hooks.warmState = () => ({ pending: warmPending(), bytes: smoothCacheBytes() });
  hooks.walkTo = (id, col, row) => officeStateRef.current?.walkToTile(id, col, row) ?? false;
  hooks.drawnDensity = (palette, hue, zoom) =>
    spritesAtZoom(getCharacterSprites(palette, hue), zoom).density;
  hooks.cacheBuildMs = (palette, hue, zoom) => {
    const s = spritesAtZoom(getCharacterSprites(palette, hue), zoom);
    const t0 = performance.now();
    for (const set of [s.walk, s.typing, s.reading])
      for (const frames of Object.values(set))
        for (const f of frames) getCachedSprite(f, zoom / s.density);
    return performance.now() - t0;
  };
  hooks.getCharacters = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    // getCharacters(), not `characters`: e2e asserts on the consent greeter,
    // which lives outside the agent map and joins only at the render seam.
    return os.getCharacters().map((ch) => ({
      id: ch.id,
      matrixEffect: ch.matrixEffect,
      agentName: ch.agentName,
      bubbleType: ch.bubbleType,
      waitingAwaitingInput: ch.waitingAwaitingInput,
      isHeadless: ch.isHeadless,
      isGreeter: ch.isGreeter,
    }));
  };

  // The ghost setting lives in the renderer module (read every rAF frame), not
  // in OfficeState, so e2e reads it from there to assert what is actually drawn.
  hooks.getGhostHeadlessAgents = () => isGhostHeadlessAgentsEnabled();
  hooks.getOtherFloorStats = () => ({ ...otherFloorStats });
  hooks.getNameplateStats = () => ({ ...nameplateStats });
  hooks.chatOpenFor = chatOpenFor;

  hooks.getCameraFollowId = () => officeStateRef.current?.cameraFollowId ?? null;

  hooks.getSelectedAgentId = () => officeStateRef.current?.selectedAgentId ?? null;

  hooks.getCharacterTile = (id) => {
    const ch = officeStateRef.current?.characters.get(id);
    return ch
      ? {
          col: ch.tileCol,
          row: ch.tileRow,
          state: ch.state,
          queued: ch.path.length,
          active: ch.isActive,
          away: !!ch.cldAway,
          ride: ch.cldRide?.phase ?? null,
          rideT: ch.cldRide?.t ?? null,
          hidden: !!ch.cldRide?.hidden,
          visit: ch.cldVisit?.floor ?? null,
        }
      : null;
  };

  hooks.getElevators = () =>
    (officeStateRef.current?.cldElevators ?? []).map(({ floor, col, row, open }) => ({
      floor,
      col,
      row,
      open,
    }));

  hooks.getCharacterPosition = (id) => {
    const ch = officeStateRef.current?.characters.get(id);
    return ch ? { x: ch.x, y: ch.y } : null;
  };

  hooks.walkAgentTo = (id, col, row) => !!officeStateRef.current?.walkToTile(id, col, row);

  hooks.isTileWalkable = (col, row) => {
    const os = officeStateRef.current;
    return !!os && isWalkable(col, row, os.tileMap, os.blockedTiles);
  };

  hooks.selectAgent = (id) => {
    const os = officeStateRef.current;
    if (os) os.selectedAgentId = id;
  };

  // Point-in-time snapshot of every live pet. Pets render only on the canvas
  // (no DOM) and the heart bubble is never persisted, so e2e reads pet state
  // through here — the same rationale as getCharacters() above.
  hooks.getPets = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    return os.pets.map((pet) => ({
      id: pet.id,
      name: pet.name,
      petType: pet.petType,
      state: pet.state,
      x: pet.x,
      y: pet.y,
      bubbleType: pet.bubbleType,
    }));
  };

  // Drive the same state a canvas click on a pet produces (toggle the heart
  // bubble). Mirrors OfficeCanvas's pet-hit branch but takes a known petId
  // instead of a hit-test result, so tests don't pixel-hunt the randomly
  // spawned sprite — the same tradeoff selectAgent makes for characters.
  hooks.petClick = (petId) => {
    const os = officeStateRef.current;
    if (!os) return;
    const pet = os.pets.find((p) => p.id === petId);
    if (!pet) return;
    if (pet.bubbleType) {
      os.dismissPetBubble(petId);
    } else {
      os.showPetBubble(petId);
    }
  };

  // ── Carpet + Areas read hooks (canvas-only state, read like getPets) ──
  hooks.getCarpetTiles = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    const layout = os.getLayout();
    const tiles = layout.carpetTiles;
    if (!tiles) return [];
    const out: Array<{
      col: number;
      row: number;
      variant: number;
      color?: ColorValue;
      accentColor?: ColorValue;
      order?: number;
    }> = [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (!t) continue;
      out.push({
        col: i % layout.cols,
        row: Math.floor(i / layout.cols),
        variant: t.variant,
        color: t.color,
        accentColor: t.accentColor,
        order: t.order,
      });
    }
    return out;
  };

  hooks.getCarpetJunctionCase = (jx, jy, variant) => {
    const os = officeStateRef.current;
    if (!os) return 0;
    const layout = os.getLayout();
    return carpetJunctionCase(jx, jy, variant, layout.carpetTiles ?? [], layout.cols, layout.rows);
  };

  hooks.getAreas = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    return (os.getLayout().areas ?? []).map((a) => ({ label: a.label, color: a.color }));
  };

  hooks.getAreaTiles = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    const layout = os.getLayout();
    const tiles = layout.areaTiles;
    if (!tiles) return [];
    const out: Array<{ col: number; row: number; label: string }> = [];
    for (let i = 0; i < tiles.length; i++) {
      const label = tiles[i];
      if (!label) continue;
      out.push({ col: i % layout.cols, row: Math.floor(i / layout.cols), label });
    }
    return out;
  };

  hooks.getAreaMappings = () => {
    const os = officeStateRef.current;
    if (!os) return {};
    return os.areaMappings;
  };

  hooks.getFurnitureCount = () => {
    const os = officeStateRef.current;
    if (!os) return 0;
    return os.furniture.length;
  };

  hooks.getTiles = () => {
    const os = officeStateRef.current;
    if (!os) return { cols: 0, rows: 0, tiles: [] };
    const layout = os.getLayout();
    return { cols: layout.cols, rows: layout.rows, tiles: [...layout.tiles] };
  };

  // Read from the layout (the persisted PlacedFurniture list), not os.furniture
  // — the latter holds render instances (walls, auto-state swaps) that don't map
  // 1:1 to what the editor placed.
  hooks.getFurniture = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    return os.getLayout().furniture.map((f) => ({
      uid: f.uid,
      type: f.type,
      col: f.col,
      row: f.row,
      color: f.color,
    }));
  };

  hooks.getAgentSeats = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    return Array.from(os.characters.values())
      .filter((ch) => !ch.isSubagent)
      .map((ch) => ({
        id: ch.id,
        seatId: ch.seatId,
        areaLabel: ch.seatId ? os.seatZone(ch.seatId) : null,
        directoryName: ch.directoryName,
      }));
  };

  hooks.getSeats = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    return Array.from(os.seats.entries()).map(([uid, seat]) => ({
      uid,
      col: seat.seatCol,
      row: seat.seatRow,
      areaLabel: os.seatZone(uid),
      assigned: seat.assigned,
    }));
  };

  const origAddAgent = OfficeState.prototype.addAgent;
  OfficeState.prototype.addAgent = function (
    id,
    preferredPalette,
    preferredHueShift,
    preferredSeatId,
    skipSpawnEffect,
    directoryName,
    nearAgentId,
  ) {
    origAddAgent.call(
      this,
      id,
      preferredPalette,
      preferredHueShift,
      preferredSeatId,
      skipSpawnEffect,
      directoryName,
      nearAgentId,
    );
    const ch = this.characters.get(id);
    hooks.addAgentLog?.push({
      id,
      skipSpawnEffect,
      matrixEffectAtCreation: ch?.matrixEffect ?? null,
    });
  };
}
