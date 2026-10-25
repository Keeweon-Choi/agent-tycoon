import type { ColorValue } from './components/ui/types.js';

// ── Messenger ───────────────────────────────────────────────
export const ATTACH_ACCEPT =
  'image/*,.pdf,.txt,.md,.csv,.json,.log,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.hpp,.cs,.sh,.bash,.zsh,.css,.html,.xml,.yaml,.yml,.sql,.toml,.zip,.7z,.tar,.gz,.tgz,.docx,.xlsx,.pptx,.odt,.ods,.odp,.doc,.xls,.ppt,.hwp,.hwpx,.rtf';

// ── Grid & Layout ────────────────────────────────────────────
export const TILE_SIZE = 16;
export const DEFAULT_COLS = 20;
export const DEFAULT_ROWS = 11;
export const MAX_COLS = 64;
export const MAX_ROWS = 64;

// ── Character Animation ─────────────────────────────────────
export const WALK_SPEED_PX_PER_SEC = 48;
export const WALK_FRAME_DURATION_SEC = 0.15;
/** Keyboard walking gets game-like input response without changing wandering pace. */
export const KEY_WALK_SPEED_PX_PER_SEC = 96;
export const KEY_WALK_FRAME_DURATION_SEC = 0.08;
export const TYPE_FRAME_DURATION_SEC = 0.3;
export const WANDER_PAUSE_MIN_SEC = 2.0;
export const WANDER_PAUSE_MAX_SEC = 20.0;
export const WANDER_MOVES_BEFORE_REST_MIN = 3;
export const WANDER_MOVES_BEFORE_REST_MAX = 6;
export const SEAT_REST_MIN_SEC = 120.0;
export const SEAT_REST_MAX_SEC = 240.0;

// ── Matrix Effect ────────────────────────────────────────────
export const MATRIX_EFFECT_DURATION_SEC = 0.3;
export const MATRIX_TRAIL_LENGTH = 6;
export const MATRIX_SPRITE_COLS = 16;
export const MATRIX_SPRITE_ROWS = 24;
export const MATRIX_FLICKER_FPS = 30;
export const MATRIX_FLICKER_VISIBILITY_THRESHOLD = 180;
export const MATRIX_COLUMN_STAGGER_RANGE = 0.3;
export const MATRIX_HEAD_COLOR = '#ccffcc';
export const matrixGreenBright = (a: number): string => `rgba(0, 255, 65, ${a})`;
export const matrixGreenMid = (a: number): string => `rgba(0, 170, 40, ${a})`;
export const matrixGreenDim = (a: number): string => `rgba(0, 85, 20, ${a})`;
export const MATRIX_TRAIL_OVERLAY_ALPHA = 0.6;
export const MATRIX_TRAIL_EMPTY_ALPHA = 0.5;
export const MATRIX_TRAIL_MID_THRESHOLD = 0.33;
export const MATRIX_TRAIL_DIM_THRESHOLD = 0.66;

// ── Rendering ────────────────────────────────────────────────
export const CHARACTER_SITTING_OFFSET_PX = 6;
export const CHARACTER_Z_SORT_OFFSET = 0.5;
export const OUTLINE_Z_SORT_OFFSET = 0.001;
export const SELECTED_OUTLINE_ALPHA = 1.0;
export const HOVERED_OUTLINE_ALPHA = 0.5;
/** Headless agents (adopted, no terminal to focus) render slightly translucent. */
export const HEADLESS_CHARACTER_ALPHA = 0.5;
export const GHOST_PREVIEW_SPRITE_ALPHA = 0.5;
export const GHOST_PREVIEW_TINT_ALPHA = 0.25;
export const SELECTION_DASH_PATTERN: [number, number] = [4, 3];
export const BUTTON_MIN_RADIUS = 6;
export const BUTTON_RADIUS_ZOOM_FACTOR = 3;
export const BUTTON_ICON_SIZE_FACTOR = 0.45;
export const BUTTON_LINE_WIDTH_MIN = 1.5;
export const BUTTON_LINE_WIDTH_ZOOM_FACTOR = 0.5;
export const BUBBLE_FADE_DURATION_SEC = 0.5;
export const BUBBLE_SITTING_OFFSET_PX = 10;
export const BUBBLE_VERTICAL_OFFSET_PX = 24;
/** Thinking bubbles reveal zero through three dots every 400 ms. */
export const THINKING_DOT_FRAME_SEC = 0.4;
export const THINKING_DOT_COLOR = '#CCA700';
export const FALLBACK_FLOOR_COLOR = '#808080';

// ── Rendering - Overlay Colors (canvas, not CSS) ─────────────
export const SEAT_OWN_COLOR = 'rgba(0, 127, 212, 0.35)';
export const SEAT_AVAILABLE_COLOR = 'rgba(0, 200, 80, 0.35)';
export const SEAT_BUSY_COLOR = 'rgba(220, 50, 50, 0.35)';
export const GRID_LINE_COLOR = 'rgba(255,255,255,0.12)';
export const VOID_TILE_OUTLINE_COLOR = 'rgba(255,255,255,0.08)';
export const VOID_TILE_DASH_PATTERN: [number, number] = [2, 2];
export const GHOST_BORDER_HOVER_FILL = 'rgba(60, 130, 220, 0.25)';
export const GHOST_BORDER_HOVER_STROKE = 'rgba(60, 130, 220, 0.5)';
export const GHOST_BORDER_STROKE = 'rgba(255, 255, 255, 0.06)';
export const GHOST_VALID_TINT = '#00ff00';
export const GHOST_INVALID_TINT = '#ff0000';
export const SELECTION_HIGHLIGHT_COLOR = '#007fd4';
export const DELETE_BUTTON_BG = 'rgba(200, 50, 50, 0.85)';
export const ROTATE_BUTTON_BG = 'rgba(50, 120, 200, 0.85)';
export const BUTTON_ICON_COLOR = '#fff';
export const CANVAS_FALLBACK_TILE_COLOR = '#444';
export const CANVAS_ERROR_TILE_COLOR = '#FF00FF';
export const WALL_COLOR = '#3A3A5C';

// ── Camera ───────────────────────────────────────────────────
export const CAMERA_FOLLOW_LERP = 0.1;
export const CAMERA_FOLLOW_SNAP_THRESHOLD = 0.5;
/** GFX2 auto camera: a click on a character zooms this many whole steps past the framed office. */
export const CAMERA_FOLLOW_ZOOM_STEPS = 2;

// ── Zoom ─────────────────────────────────────────────────────
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 10;
export const ZOOM_DEFAULT_DPR_FACTOR = 2;
export const ZOOM_LEVEL_FADE_DELAY_MS = 1500;
export const ZOOM_LEVEL_HIDE_DELAY_MS = 2000;
export const ZOOM_LEVEL_FADE_DURATION_SEC = 0.5;
export const ZOOM_SCROLL_THRESHOLD = 50;
export const PAN_MARGIN_FRACTION = 0.25;
/** GFX: a HUD panel or safe area takes at most this share of a canvas side from the framed view. */
export const FRAME_MAX_INSET_FRACTION = 0.4;
/** GFX2 backdrop: world px per picture px of the city seen from above. The owner's scene is a
 *  miniature (a desk 11 px wide, ours 48), so its streets and roofs read as far below the office
 *  at 2: whole device px at every whole zoom, half as fine as the office's own pixels. */
export const TOPDOWN_WORLD_PX = 2;
/** GFX 2.5D: the depth key of a 'foreground' item (drawn after every standing thing). */
export const FOREGROUND_Z = 1_000_000;
/** GFX 2.5D ground decals (world px, pixel-art ellipses baked like sprites). 'ground' shadow:
 *  as wide as the footprint less this inset, this tall, its colour. */
export const SHADOW_GROUND = { insetPx: 2, heightPx: 4, color: '#00000040' } as const;
/** 'warm-pool' light: an ellipse on the floor, three rings from the rim in (alpha rising). */
export const LIGHT_WARM_POOL = {
  rx: 20,
  ry: 9,
  rings: [
    { at: 1, color: '#FFD27A1F' },
    { at: 0.7, color: '#FFD27A33' },
    { at: 0.4, color: '#FFE3A44D' },
  ],
} as const;
/** 2.5D PILOT walls: the navy of the owner's converted wall pieces (wall-dark-panel,
 *  wall-top-thin), the face heights (world px above the tile's bottom: an outside wall, nothing
 *  behind it to hide, stands twice as tall and holds windows), and every how many columns an
 *  inside wall carries a lit wood panel with a lamp. */
export const WALL_25D = {
  // The top a shade lighter than the faces: lit from above, it reads apart from the void.
  cap: '#233755',
  capEdge: '#3B4C6C',
  lip: '#3B4C6C',
  lip2: '#233755',
  face: '#1A273E',
  seam: '#233755',
  shadow: '#0C1426',
  frame: '#0C1426',
  capPx: 16,
  insideFacePx: 16,
  outsideFacePx: 32,
  lampEvery: 4,
} as const;
/** 2.5D PILOT: how far below a wall lamp its light pool lies on the floor (world px). */
export const WALL_LAMP_POOL_DY = 5;
/** GFX e2e: the one-sprite-px marker of the synthetic HD character (testHooks makeHdCharacter). */
export const HD_TEST_MARKER_COLOR = '#FFFFFF';
/** GFX title scene: over the HUD (48-49), under the dialogs (50+) its menu opens. */
export const TITLE_SCENE_Z = 49;
/** GFX title scene: the owner's logo sign (art px), drawn at whole device px per art px, as wide
 *  as the title box allows and at most this share of the window's height (a phone held sideways). */
export const TITLE_LOGO = { w: 135, h: 62, maxHeightShare: 0.25 } as const;
/** GFX lobby: the title box around the logo (CSS px; pixel-panel's border is 2 px), its widest
 *  on a desktop (rem and a share of the window), and the phone's side gutter. */
export const TITLE_BOX = {
  padPx: 12,
  borderPx: 2,
  maxRem: 24,
  maxWidthShare: 0.4,
  leftShare: 0.06,
  phoneGutterPx: 16,
  /** Kept between the menu and the cast at the counter. */
  castGapPx: 16,
} as const;
/** GFX2 lobby: the wide picture above this aspect (width / height), else the 4:3 one; the
 *  cast drawn at about this many picture px per world px (the picture's own figures' size),
 *  a seated figure's world rows above the counter, and how fast the idle frames change. */
export const LOBBY_ART = {
  wideMinAspect: 1.7,
  castArtPxPerWorld: 3.5,
  /** Half a figure's width in picture px (8 world px at castArtPxPerWorld). */
  castHalfArtPx: 28,
  seatedRows: 25,
  typeFrameMs: 300,
  idleFrameMs: 900,
} as const;
/** The browser lays boxes out in 1/64 CSS px (Blink's LayoutUnit). */
export const LAYOUT_UNITS_PER_PX = 64;

// ── Editor ───────────────────────────────────────────────────
export const UNDO_STACK_MAX_SIZE = 50;
export const LAYOUT_SAVE_DEBOUNCE_MS = 500;
/** data-testid of the office canvas — e2e drives real editor gestures on it. */
export const OFFICE_CANVAS_TEST_ID = 'office-canvas';
/** Ghost-border hover tile when the border isn't shown — off any reachable tile. */
export const GHOST_BORDER_NO_HOVER_TILE = -999;

// ── Layout Import/Export (browser-native, standalone) ────────
/** Suggested filename when exporting the office layout from the standalone browser. */
export const LAYOUT_EXPORT_FILENAME = 'pixel-agents-layout.json';
/** MIME type for the exported layout Blob. */
export const LAYOUT_EXPORT_MIME = 'application/json';
export const DEFAULT_FLOOR_COLOR: ColorValue = { h: 35, s: 30, b: 15, c: 0 };
export const DEFAULT_WALL_COLOR: ColorValue = { h: 240, s: 25, b: 0, c: 0 };
export const DEFAULT_NEUTRAL_COLOR: ColorValue = { h: 0, s: 0, b: 0, c: 0 };

// ── Carpets ──────────────────────────────────────────────────
/** Main (lowest-luminance) color applied to carpets when no per-tile override is set. */
export const CARPET_DEFAULT_COLOR: ColorValue = { h: 0, s: 71, b: -32, c: 0, colorize: true };
/** Accent (highest-luminance) color applied to carpets when no per-tile override is set. */
export const CARPET_DEFAULT_ACCENT_COLOR: ColorValue = {
  h: 34,
  s: 64,
  b: 21,
  c: 0,
  colorize: true,
};
/** Keyboard key that switches from CARPET_PAINT to CARPET_PICK while editing. */
export const KEY_CARPET_PICK = 'p';

// ── Areas (named, colored Directory zones) ───────────────────
/** Color palette assigned to new Areas in rotation (cycles when more areas exist). */
export const AREA_DEFAULT_COLORS: readonly string[] = [
  '#ff6b6b',
  '#feca57',
  '#48dbfb',
  '#1dd1a1',
  '#5f27cd',
  '#ff9ff3',
  '#54a0ff',
  '#ffa502',
] as const;
/** Translucent overlay alpha for area tile fills. */
export const AREA_OVERLAY_ALPHA = 0.25;
/** Alpha multiplier applied to the actively-selected area's overlay. */
export const AREA_ACTIVE_ALPHA_MULTIPLIER = 1.6;
/** Base font size (pixel-pre-zoom) for area centroid labels. */
export const AREA_LABEL_FONT_SIZE_PX = 14;
/** Minimum on-screen label size to keep labels legible at low zoom. */
export const AREA_LABEL_MIN_FONT_SIZE_PX = 12;
/** Alpha of the area label text. */
export const AREA_LABEL_ALPHA = 1.0;
/** Fallback label color when an area has no color set (shouldn't happen in practice). */
export const AREA_LABEL_FALLBACK_COLOR = '#ffffff';
/** Drop-shadow color behind area labels for legibility on light backgrounds. */
export const AREA_LABEL_SHADOW_COLOR = '#000000';
/** Drop-shadow alpha behind area labels. */
export const AREA_LABEL_SHADOW_ALPHA = 0.6;

// ── VisualColorPicker (HSV wheel + brightness for carpets) ───
export const VISUAL_COLOR_PICKER_SV_SIZE_PX = 180;
export const VISUAL_COLOR_PICKER_HUE_WIDTH_PX = 20;
export const VISUAL_COLOR_PICKER_MARKER_RADIUS_PX = 6;
/**
 * The hue bar gradient is intrinsic to the color-picking interaction, not a
 * theme color — it must span the full hue circle. Centralized here so the
 * component body stays free of inline color literals. (The saturation/brightness
 * square is painted to a canvas from the carpet HSL model, not a CSS gradient.)
 */
export const VISUAL_COLOR_PICKER_HUE_GRADIENT =
  'linear-gradient(to bottom, ' +
  '#ff0000 0%, #ffff00 16.7%, #00ff00 33.3%, ' +
  '#00ffff 50%, #0000ff 66.7%, #ff00ff 83.3%, #ff0000 100%)';
export const VISUAL_COLOR_PICKER_MARKER_BORDER = '2px solid #fff';
export const VISUAL_COLOR_PICKER_MARKER_SHADOW = '0 0 0 1px rgba(0,0,0,0.6)';
/** Width of the collapsed swatch + hex trigger row (compact mode). */
export const VISUAL_COLOR_PICKER_COMPACT_WIDTH_PX = 160;
/** Swatch square size shown in the collapsed trigger. */
export const VISUAL_COLOR_PICKER_SWATCH_PX = 22;
/** Gap (px) between the collapsed trigger and the expanded popup panel. */
export const VISUAL_COLOR_PICKER_POPUP_GAP_PX = 6;

// ── Notification Sound (done: ascending chime) ─────────────
export const NOTIFICATION_NOTE_1_HZ = 659.25; // E5
export const NOTIFICATION_NOTE_2_HZ = 1318.51; // E6 (octave up)
export const NOTIFICATION_NOTE_1_START_SEC = 0;
export const NOTIFICATION_NOTE_2_START_SEC = 0.1;
export const NOTIFICATION_NOTE_DURATION_SEC = 0.18;
export const NOTIFICATION_VOLUME = 0.14;

// ── Permission Sound (attention: descending double tap) ────
export const PERMISSION_NOTE_1_HZ = 880; // A5
export const PERMISSION_NOTE_2_HZ = 659.25; // E5 (down a fourth)
export const PERMISSION_NOTE_1_START_SEC = 0;
export const PERMISSION_NOTE_2_START_SEC = 0.12;
export const PERMISSION_NOTE_DURATION_SEC = 0.15;
export const PERMISSION_VOLUME = 0.12;

// ── Job Sound (cld-gui T-0039: a job or Codex task finished) ──
export const JOB_NOTES_HZ = [1046.5, 1318.51, 1567.98]; // C6 E6 G6
export const JOB_NOTE_STEP_SEC = 0.08;
export const JOB_NOTE_DURATION_SEC = 0.14;
export const JOB_VOLUME = 0.1;

// ── Notices (cld-gui T-0039: toast, pulse, bell) ───────────
/** The bell keeps this many notices. */
export const NOTICE_LIST_MAX = 50;
export const NOTICE_TOAST_MS = 6_000;
/** How long the character pulses, and one pulse's length. */
export const NOTICE_PULSE_MS = 3_000;
/** A notice jump waits this long for a message that has not reached the conversation yet. */
export const JUMP_WAIT_MS = 5_000;
/** cld-gui (T-0043): a turn end and a messenger reply this close together are one notice. */
export const NOTICE_PAIR_MS = 15_000;
export const NOTICE_PULSE_PERIOD_MS = 1_000;
export const NOTICE_PULSE_COLOR = '#ffd84a';
/** Feed events this soon after a connection's snapshot began are its replay, not news. */
export const NOTICE_FEED_REPLAY_MS = 2_000;
export const NOTICE_DEFAULT_VOLUME = 0.8;

// ── The lobby board (cld-gui T-0046) ─────────────────────────
/** The board's furniture type (server/src/cld/layout.ts BOARD_TYPE). */
export const BOARD_TYPE = 'LED_BOARD';
/** The LED screen inside the board sprite, sprite px (cld/scripts/gen-lobby-assets.ts). */
export const BOARD_SCREEN = { x: 5, y: 5, w: 438, h: 146 } as const;
/** The default view keeps the board's left end this many CSS px in: clear of the elevator panel (right edge 76 px) with a gap. */
export const BOARD_CLEAR_LEFT_PX = 84;
/** The board's pages turn this often while it is on screen. */
export const BOARD_PAGE_MS = 20_000;
/** A tab picked by hand holds its page this long before the board turns again. */
export const BOARD_PICK_HOLD_MS = 60_000;
/** The board on the canvas lays out this many em wide (font size = width / this). */
export const BOARD_EM_WIDTH = 48;
/** Below this many CSS px per em the board is too small to read: it keeps a static frame. */
export const BOARD_MIN_EM_PX = 10;
/** The full-screen board on a phone held upright: 18 px em (Galmuri11 is crisp at 18). */
export const BOARD_FULL_EM_PX = 18;
/** The full-screen board keeps the board's shape while its em fits at least this. */
export const BOARD_FULL_MIN_EM_PX = 14;
/** Under the character labels (41-43) and the card bar (30): the board is part of the world. */
export const BOARD_Z_INDEX = 20;
/** The full-screen board, over the office's bars and panels. */
export const BOARD_FULL_Z_INDEX = 70;
// ── Attachment viewer (messenger) ───────────────────────────
/** Over the full-screen board (70) and every office panel. */
export const ATTACH_VIEWER_Z_INDEX = 80;
/** Highest zoom, as a multiple of the image's own pixels (800%). */
export const ATTACH_ZOOM_MAX = 8;
/** One +/- button press, and one arrow-key press. */
export const ATTACH_ZOOM_STEP = 1.25;
/** One click or tap from fit doubles the fitted scale. */
export const ATTACH_TAP_ZOOM_FACTOR = 2;
/** Space kept around a fitted image. */
export const ATTACH_FIT_MARGIN_PX = 8;
/** Wheel zoom: scale *= exp(-deltaY * this); a pixel-mode notch of 100 is about 18%. */
export const ATTACH_WHEEL_SENSITIVITY = 0.0018;
/** A scale this close to fit counts as fitted (not zoomed in). */
export const ATTACH_FIT_EPSILON = 0.02;
/** A horizontal drag this long, not zoomed in, goes to the next/previous attachment. */
export const ATTACH_SWIPE_PX = 56;
/** Two taps this close in time and place are a double tap. */
export const ATTACH_DOUBLE_TAP_MS = 350;
export const ATTACH_DOUBLE_TAP_PX = 32;
/** Projects on the board's first page before "외 N". */
export const BOARD_PROJECT_ROWS = 8;
/** H/W graphs cover the last 60 s (hwSample comes every 2 s while anyone views). */
export const BOARD_HISTORY_MS = 60_000;
export const BOARD_HISTORY_SAMPLES = 40;
/** A GPU ticket's ending stays on the board this long, fading out. */
export const BOARD_RECENT_MS = 3 * 60_000;
/** The board's colours: an LED screen on near black. The series hues pass the
 *  dataviz validator on `screen` (dark, all pairs; each chart is one series
 *  and named in words, which covers its CVD warn). */
export const BOARD_COLORS = {
  screen: '#07080d',
  grid: '#1a2030',
  track: '#1c2233',
  text: '#e8eefc',
  muted: '#8a93ab',
  cpu: '#1a9cc4',
  gpu: '#9a6cf0',
  disk: '#d0609c',
  ok: '#58d46a',
  warn: '#f0b43c',
  critical: '#f0483c',
} as const;
/** The wall's copy of the HW page has room for this many donuts (one row) and temperature bars (two columns). */
export const BOARD_HW_MINI_DONUTS = 6;
export const BOARD_HW_MINI_BARS = 8;
/** The per-core table: rows per column, and at most this many columns (more cores: "+n"). */
export const BOARD_HW_CORE_ROWS = 7;
export const BOARD_HW_CORE_COLS = 3;
/** Area fill under a line: the series hue as a wash. */
export const BOARD_AREA_ALPHA = 0.22;

// ── Whiteboard memos (cld-gui T-0065) ─────────────────────────
/** The whiteboard's furniture type (server/src/cld/layout.ts WHITEBOARD_TYPE). */
export const WHITEBOARD_TYPE = 'WHITEBOARD';
/** The writable face inside the 32x32 whiteboard sprite, in sprite px (its white inside the frame). */
export const WHITEBOARD_FACE = { x: 5, y: 12, w: 22, h: 9 } as const;
/** A memo line is this many sprite px tall; the face holds WHITEBOARD_LINES of them. */
export const WHITEBOARD_LINE_UNITS = 3;
export const WHITEBOARD_LINES = 3;
/** The marker's font size, in sprite px per em (the line height is WHITEBOARD_LINE_UNITS). */
export const WHITEBOARD_FONT_UNITS = 2.5;
/** A memo's longest text (server MEMO_MAX). */
export const WHITEBOARD_MEMO_MAX = 600;
/** Marker ink on the white face. */
export const WHITEBOARD_INK = '#1c2c58';
/** Part of the world, like the lobby board: under the labels (41-43) and the panels. */
export const WHITEBOARD_Z_INDEX = 19;

// ── Furniture Animation ─────────────────────────────────────
export const FURNITURE_ANIM_INTERVAL_SEC = 0.2;

// ── Version Notice ──────────────────────────────────────────
export const WHATS_NEW_AUTO_CLOSE_MS = 20000;
export const WHATS_NEW_FADE_MS = 1000;

// ── Game Logic ───────────────────────────────────────────────
export const MAX_DELTA_TIME_SEC = 0.1;
/** cld-gui (T-0075): the office canvas, and the overlays that share its pacer,
 *  draw this often while nothing on it moves (the typing and reading frames
 *  change slower than that, so idle characters look the same). Motion, and
 *  input on the office, take it back to the full frame rate on the very frame
 *  they start. */
export const OFFICE_IDLE_FPS = 10;
/** How long after the last pointer, touch, wheel or key input the office keeps
 *  drawing at the full rate (a hover, a drag, a key walk about to begin). */
export const OFFICE_INPUT_GRACE_MS = 800;
/** The office counts as on screen from this share of the canvas visible. */
export const OFFICE_VISIBLE_RATIO = 0.001;
export const WAITING_BUBBLE_DURATION_SEC = 2.0;
export const DISMISS_BUBBLE_FAST_FADE_SEC = 0.3;
export const INACTIVE_SEAT_TIMER_MIN_SEC = 3.0;
export const INACTIVE_SEAT_TIMER_RANGE_SEC = 2.0;
/** Default/fallback palette count (bundled characters). Actual count comes from getLoadedCharacterCount(). */
export const PALETTE_COUNT = 6;
export const AUTO_ON_FACING_DEPTH = 3;
export const AUTO_ON_SIDE_DEPTH = 2;
export const CHARACTER_HIT_HALF_WIDTH = 8;
export const CHARACTER_HIT_HEIGHT = 24;
export const TOOL_OVERLAY_VERTICAL_OFFSET = 32;

// ── Greeter + Intro bubble ──────────────────────────────────
/** Reserved character id for the Intro's greeter. Far outside both real agent
 *  ids (positive) and sub-agent ids (small negatives from -1 down). */
export const GREETER_ID = -1_000_000_000;
/** Stacking order for the Intro's bubble. Deliberately BELOW the modal stack
 *  (ui/Modal defaults to 50, ChangelogModal 51, the migration notice z-100): the
 *  Intro is diegetic furniture over the office, not a modal, so a modal opened
 *  on top of it must cover it rather than slide underneath. */
export const INTRO_BUBBLE_Z_INDEX = 45;
/** O4: how long a saved skip-permissions choice may wait for the server's confirmation before the Intro's buttons come back. */
export const BYPASS_ANSWER_TIMEOUT_MS = 6000;
/** ToolOverlay stacking: status label panels (selected one on top), then the
 *  characters' speech bubbles above every label — all below the Intro bubble. */
/** WINDOW-LAYERS: inside the HUD layer, normal windows are 1..n; the fixed panels (card bar, icon dock,
 *  elevator panel) sit at this z, a maximized window at HUD_MAXIMIZED_Z + its place in the order. */
export const HUD_PANELS_Z = 20;
export const HUD_MAXIMIZED_Z = 30;
export const OVERLAY_LABEL_Z_INDEX = 41;
export const OVERLAY_LABEL_SELECTED_Z_INDEX = 42;
export const OVERLAY_BUBBLE_Z_INDEX = 43;
// cld EZ mode head badge: world px from the character anchor (bottom centre)
// to the badge's bottom-right corner, left of the head (the prop is on the right).
export const EZ_MOOD_ICON_OFFSET_X = -7;
export const EZ_MOOD_ICON_OFFSET_Y = 18;
// cld T-0026 activity visuals (webview-ui/src/cld/ez/): the status ring under
// each character, by state. Rims are opaque, fills translucent (#RRGGBBAA); the
// dark edge keeps a ring readable on any floor or cushion ('' = none).
const RING_EDGE = '#14141cb3';
export const ACTIVITY_RING_COLORS = {
  working: { rim: '#58d46a', fill: '#58d46a55', edge: RING_EDGE },
  waiting: { rim: '#f0b43c', fill: '#f0b43c55', edge: RING_EDGE },
  permission: { rim: '#f0483c', fill: '#f0483c66', edge: RING_EDGE },
  idle: { rim: '#a8aac0', fill: '#a8aac044', edge: RING_EDGE },
  off: { rim: '#4a4a5a80', fill: '#00000030', edge: '' },
  neutral: { rim: '#00000059', fill: '#00000033', edge: '' },
} as const;
/** Blink period (s) of the waiting (slow) and permission (fast) rings; the
 *  off half draws the ring at the dim alpha, never hides it. */
export const ACTIVITY_RING_BLINK_SEC = { waiting: 1.6, permission: 0.6 } as const;
export const ACTIVITY_RING_BLINK_DIM_ALPHA = 0.3;
/** Seconds per frame of an animated prop (flask bubbles, hammer swing...). */
export const ACTIVITY_PROP_FRAME_SEC = 0.35;
/** An idle character dims slightly: colorize.adjustSprite's HSL shift. Darker only: the shift
 *  subtracts saturation, so any cut turns soft colours (sheer brown stockings, S 0.17) grey. */
export const ACTIVITY_IDLE_DIM = { h: 0, s: 0, b: -24, c: 0 } as const;
/** 🤝 speech link to the sub-agent: dot and its drop shadow, every N world px. */
export const ACTIVITY_LINK_DOT_COLOR = '#f4f4f8';
export const ACTIVITY_LINK_SHADOW_COLOR = '#2a2131';
export const ACTIVITY_LINK_DOT_SPACING = 3;
/** Seconds per step of the link's marching dots. */
export const ACTIVITY_LINK_MARCH_SEC = 0.2;
// cld T-0026 피로도 (fatigue): the bar by tone, how a tired character moves,
// and the rest bubble. The thresholds are EZ rules data (cld/ez/rules.ts).
/** U-15 XP bar fill (Lv / 환생 beside the 피로도 bar). */
export const LEVEL_BAR_COLOR = '#6aa7ff';
// charpack v3 §6A nameplate (cld/ez/nameplate.ts): [rank] [name] [Lv in an XP ring] + 피로도.
/** The XP ring's empty arc (the filled one is LEVEL_BAR_COLOR). */
export const LEVEL_RING_EMPTY_COLOR = '#3a3a52';
/**
 * RANK-LEVELS: one colour pair (main, dark) per rank, in THEME.ranks order, along one ramp:
 * grey, green, blue, purple, gold. Past the end the last pair is used.
 */
export const RANK_COLORS = [
  { main: '#9a9dab', dark: '#646775' },
  { main: '#7bd06a', dark: '#4a9a42' },
  { main: '#3fae7a', dark: '#2a7c58' },
  { main: '#4fb0e8', dark: '#2e7cb0' },
  { main: '#3a78d0', dark: '#27508f' },
  { main: '#4a5cc8', dark: '#303c8c' },
  { main: '#8a5ad0', dark: '#5e3a96' },
  { main: '#b04ed0', dark: '#78309a' },
  { main: '#d9a02a', dark: '#9c7016' },
  { main: '#f0bd32', dark: '#b08820' },
  { main: '#ffe066', dark: '#c9a431' },
] as const;
/** The rank icons' fixed colours: the ID card's face and text lines, and the star. */
export const RANK_ICON_CARD = '#f4f4f8';
export const RANK_ICON_CARD_LINE = '#c9cbd6';
export const RANK_ICON_STAR = '#fff6a0';
/** An off character's overlay (its plate), unless selected or hovered (nameplate.ts offAlpha). */
export const OFF_OVERLAY_ALPHA = 0.55;
/** The XP ring's stroke, CSS px (every size step). */
export const NAMEPLATE_RING_STROKE_PX = 3;
/**
 * UI-SCALE: the plate's sizes per 화면 크기 step (cld/uiScale.ts), CSS px. Plain
 * px, not times --ui-scale: the owner's numbers per step (10-24 16:07) --
 * 작게 the first plates, 보통 the phone's of 8144de68, 크게 the desktop's of f08882ee.
 * name/level: fonts; ring: the XP ring's outer size; fatigue: the 피로도 row's font,
 * its bar's height and least width; rank/status: CSS px per sprite pixel of the
 * rank icon and of the status icon (zzz, !, lock); nameMax: the name's max width
 * before an ellipsis.
 */
export const NAMEPLATE_SIZES = {
  small: {
    name: 16,
    level: 16,
    ring: 20,
    fatigue: 12,
    barHeight: 4,
    barMin: 14,
    rank: 2,
    status: 1,
    nameMax: 104,
  },
  medium: {
    name: 16,
    level: 16,
    ring: 22,
    fatigue: 14,
    barHeight: 6,
    barMin: 20,
    rank: 2,
    status: 2,
    nameMax: 104,
  },
  large: {
    name: 20,
    level: 20,
    ring: 26,
    fatigue: 18,
    barHeight: 6,
    barMin: 20,
    rank: 3,
    status: 2,
    nameMax: 150,
  },
} as const;
/** UI-SCALE: --ui-scale per 화면 크기 step: Tailwind's spacing and text sizes (index.css) times this. */
export const UI_SCALE_FACTORS = { small: 0.875, medium: 1, large: 1.25 } as const;
/** A plate that overlaps another (and is neither selected nor hovered) shows at this opacity. */
export const NAMEPLATE_OVERLAP_OPACITY = 0.6;
/** Plates overlapping by this much or less (their borders and padding) count as apart: no text is covered. */
export const NAMEPLATE_OVERLAP_SLOP_PX = 4;
/** The overlap pass runs at most this often (and at once on selection, hover and resize). */
export const NAMEPLATE_PASS_MS = 200;
/** Plates keep this far inside the office's edges. */
export const NAMEPLATE_EDGE_MARGIN_PX = 2;
export const FATIGUE_BAR_COLORS = { fresh: '#58d46a', tired: '#f0c43c', worn: '#f0483c' } as const;
/** A tired character walks at this fraction of its normal pace. */
export const FATIGUE_WALK_PACE = 0.6;
/** A yawn lasts this long, once in this many seconds (each character on its own phase). */
export const FATIGUE_YAWN_SEC = 1.5;
/** REST-ANIM: the drink a character takes when its 휴식 (compaction) count goes up live. */
export const REST_ANIM_SEC = 2.5;
/** …lifted to the mouth after this long, and lowered for the last REST_LIFT_SEC. */
export const REST_LIFT_SEC = 0.4;
/** Counts that arrive this soon after a (re)connect are replay, never a rest moment. */
export const REST_SETTLE_MS = 5000;
export const FATIGUE_YAWN_EVERY_SEC = 7;
// cld T-0036 status icon above the head (cld/ez/drawVisuals.ts): world px from
// the feet anchor to the icon's bottom centre, a little left so it clears the
// hand and lock props on the right.
export const STATUS_ICON_RISE_PX = 28;
export const STATUS_ICON_OFFSET_X = -2;
/** The working icon: the activity emoji in a small box, in world px. */
export const STATUS_ICON_BOX_PX = 11;
export const STATUS_ICON_EMOJI_PX = 8;
export const STATUS_ICON_BOX_BG = '#1e1e2e';
export const STATUS_ICON_BOX_BORDER = '#4a4a6a';
/** Seconds per zzz / "!" frame; the lock blinks at the permission ring's pace. */
export const STATUS_ICON_FRAME_SEC = 0.5;
export const STATUS_ICON_BLINK_DIM_ALPHA = 0.2;
/** A name-less character's details float this far (world px) above its feet, over the icon. */
export const STATUS_DETAILS_RISE_PX = 41;
// cld T-0041 staff (cld/staff.ts): temps come and go, office hours.
/** How often the staff director looks (game s). */
export const STAFF_STEP_SEC = 0.25;
/** Loading (page open, resync): the steady state is put down this long (game s)
 *  after the office snapshot, once ToolOverlay has worked out every ring from it
 *  (at most STAFF_VISUALS_WAIT_SEC more: 자세히 mode publishes none). Without
 *  any office snapshot, characters are held at most STAFF_HOLD_MAX_SEC. */
export const STAFF_SETTLE_SEC = 0.5;
export const STAFF_VISUALS_WAIT_SEC = 1.5;
export const STAFF_HOLD_MAX_SEC = 5;
/** An orchestrator idle this long after hours goes home: a turn's end, or the pause between the
 *  owner's messages, is no reason yet (20 s showed 퇴근 between replies, owner 10-24 22:21). */
export const HOME_GRACE_MS = 30 * 60_000;
/** A walk to the door that took longer than this (game s) ends where it is. */
export const LEAVE_TIMEOUT_SEC = 60;
// cld ELEVATOR (cld/elevator.ts): characters ride between floors.
/** The doors open (or shut) in this long (game s). */
export const ELEVATOR_DOOR_SEC = 0.45;
/** A missing or interrupted door animation gives up after this long, never trapping a rider. */
export const ELEVATOR_DOOR_WAIT_SEC = 2;
/** A rider steps into (or out of) the car in this long. */
export const ELEVATOR_STEP_SEC = 0.35;
/** The ride itself, plus this much per floor passed. */
export const ELEVATOR_RIDE_SEC = 0.8;
export const ELEVATOR_RIDE_PER_FLOOR_SEC = 0.35;
/** A character dropped on another floor stands this far (tiles) at most from its elevator there. */
export const ELEVATOR_VISIT_NEAR_TILES = 4;
/** The elevator's pixels (a steel frame, the car's dark inside, two sliding doors, the call lamp). */
export const ELEVATOR_COLORS = {
  frame: '#4f5566',
  trim: '#8e97aa',
  car: '#1c1e26',
  door: '#c2c9d6',
  seam: '#7f8798',
  lampOn: '#ffd166',
  lampOff: '#4a4636',
} as const;
/** A lingering temp with no lounge on its floor stays this close (tiles) to its desk. */
export const NEAR_SEAT_TILES = 3;
/** Temp rows shown before "외 N" (the 현황판 and the "+N" list). */
export const TEMP_ROWS_MAX = 5;
/** Model badges at a temp's feet: Claude's in cool tones, Codex's in warm ones. */
export const MODEL_BADGE_COLORS = {
  opus: '#b48cf0',
  sonnet: '#5aa0f0',
  haiku: '#58d4a8',
  sol: '#f0b43c',
  terra: '#c8844c',
  luna: '#d8d8f0',
} as const;
export const MODEL_BADGE_TEXT = '#14141c';
/** The rest bubble: the speech bubbles' own fill and outline (bubble-*.json). */
export const REST_BUBBLE_BG = '#eeeeff';
export const REST_BUBBLE_BORDER = '#555566';
export const REST_BUBBLE_TEXT = '#2a2131';
/** The greeter stands this many tiles in from the office's bottom-left corner
 *  (target tile (margin, rows-1-margin); nearest walkable tile if blocked). */
export const GREETER_TILE_MARGIN = 3;
/** World px above the greeter's anchor (feet) where the bubble's bottom sits.
 *  Kept well above the head target (INTRO_TAIL_TARGET_RISE_WORLD) so the
 *  tail squares have a visible run between bubble and head. */
export const INTRO_BUBBLE_ANCHOR_RISE_WORLD = 44;
/** World px right of the greeter's center where the bubble's left edge starts —
 *  just clear of the sprite so the tail points down-left at the head. */
export const INTRO_BUBBLE_OFFSET_X_WORLD = 10;
/** Bubble width cap (CSS px) and the margin kept from the container edges.
 *  Wide on purpose: the disclosure reads as three short paragraphs instead of
 *  a tall column (still clamped to the container on narrow panels). */
export const INTRO_BUBBLE_MAX_WIDTH_PX = 560;
export const INTRO_BUBBLE_EDGE_MARGIN_PX = 4;
/** Where the Intro's Claude Code step sends people who don't have it yet. */
export const CLAUDE_CODE_URL = 'https://claude.com/claude-code';
export const CLAUDE_CODE_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
/** Speech-tail squares: placed at fraction `t` along the segment from the
 *  bubble's nearest edge point to the greeter's head, shrinking toward the
 *  speaker. Recomputed every frame so the tail stays connected no matter where
 *  edge-clamping or panning puts the bubble relative to the character. */
export const INTRO_TAIL_STEPS = [
  { t: 0.25, size: 12 },
  { t: 0.55, size: 9 },
  { t: 0.82, size: 6 },
] as const;
/** World px above the greeter's anchor (feet) the tail points at — the head. */
export const INTRO_TAIL_TARGET_RISE_WORLD = 26;
/** Camera-offset caps while centering character + bubble. The ideal composition
 *  assumes the bubble fits beside/above the character; when it can't (narrow or
 *  short viewports clamp the bubble to the screen), uncapped offsets shove the
 *  greeter to the viewport edge. Horizontal offset is capped to this fraction
 *  of the viewport; vertical offset always keeps this many world px of the
 *  character visible above the bottom edge. */
export const INTRO_CAMERA_MAX_X_OFFSET_VIEWPORT_FRACTION = 0.25;
export const INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD = 48;
/** Extra downward camera shift (CSS px) so the character+bubble composition
 *  sits a bit above the vertical center instead of dead-centered. */
export const INTRO_CAMERA_DOWN_SHIFT_PX = 50;

// ── Context Fuel Gauge ──────────────────────────────────────
/** Window assumed before the runtime reports one (it always does for agents
 *  that have taken a turn; this only covers characters created ahead of it). */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
export const CONTEXT_WARN_THRESHOLD = 0.6;
export const CONTEXT_DANGER_THRESHOLD = 0.8;
export const CONTEXT_CRITICAL_THRESHOLD = 0.95;
export const CONTEXT_GAUGE_WIDTH_PX = 40;
export const CONTEXT_GAUGE_HEIGHT_PX = 4;
export const CONTEXT_GAUGE_COLOR_OK = '#44cc44';
export const CONTEXT_GAUGE_COLOR_WARN = '#ffcc00';
export const CONTEXT_GAUGE_COLOR_DANGER = '#ff8800';
export const CONTEXT_GAUGE_COLOR_CRITICAL = '#ff2222';
export const CONTEXT_GAUGE_BG = '#222';

// ── Agent Teams ─────────────────────────────────────────────
export const TEAM_LEAD_COLOR = '#ffd700';
export const TEAM_ROLE_COLOR = '#66aaff';

// ── Pets ────────────────────────────────────────────────────────
/** Walking speed in world pixels per second (matches character walk speed visually but slower). */
export const PET_WALK_SPEED_PX_PER_SEC = 32;
/** Time per WALK animation cycle step (4 cycle steps × 0.15s = 0.6s per loop). */
export const PET_WALK_FRAME_DURATION_SEC = 0.15;
/** Time per IDLE animation cycle step (4 cycle steps × 0.3s = 1.2s per loop). */
export const PET_IDLE_FRAME_DURATION_SEC = 0.3;
/** Walk cycle: 4-step lookup into the 3-frame walkDown/walkUp/walkRight arrays. */
export const PET_WALK_SEQUENCE = [0, 1, 0, 2] as const;
/** Idle cycle: 4-step lookup into the 3-frame idleDown/idleUp arrays. */
export const PET_IDLE_SEQUENCE = [0, 1, 2, 1] as const;
/** Minimum seconds the pet stays in IDLE before making a new decision. */
export const PET_WANDER_PAUSE_MIN_SEC = 3.0;
/** Maximum seconds the pet stays in IDLE before making a new decision. */
export const PET_WANDER_PAUSE_MAX_SEC = 15.0;
/** Seconds between FOLLOW path re-computations. */
export const PET_FOLLOW_RECALC_INTERVAL_SEC = 1.0;
/** Probability that a pet enters FOLLOW (instead of WALK) when wanderTimer expires. */
export const PET_FOLLOW_CHANCE = 0.3;
/** Maximum Manhattan distance (tiles) at which a character can become a follow target. */
export const PET_FOLLOW_RADIUS_TILES = 3;
/** Minimum seconds a FOLLOW episode lasts before timing out. */
export const PET_FOLLOW_DURATION_MIN_SEC = 5.0;
/** Maximum seconds a FOLLOW episode lasts before timing out. */
export const PET_FOLLOW_DURATION_MAX_SEC = 15.0;
/** Hit-box half-width (world px) for pet click detection. */
export const PET_HIT_HALF_WIDTH = 8;
/** Hit-box height (world px) measured upward from the bottom-center anchor. */
export const PET_HIT_HEIGHT = 16;
/** Zoom factor used to draw pet thumbnails in the EditorToolbar Pets tab. */
export const PET_THUMB_ZOOM = 2;
/** Scale margin so the pet thumbnail fills the ItemSelect cell without touching the edges. */
export const PET_THUMB_SCALE_MARGIN = 0.85;
/** Fallback background fill for sprite-less thumbnail (used while pet sprites are loading). */
export const EMPTY_SPRITE_THUMBNAIL_BG = '#333';
/** Maximum string length for a PlacedPet.id (defends against pathologically-long layout entries). */
export const MAX_PET_ID_LENGTH = 128;

// ── WebSocket reconnect (standalone only) ────────────────────
/** Reconnect backoff ladder shared by the /ws transport and every terminal
 *  socket (transport/reconnectBackoff.ts). The last rung repeats. */
export const WS_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
/** cld-gui (T-0025): coming back to the foreground, a socket that stays silent
 *  this long is taken for dead and replaced at once (iOS cuts a backgrounded
 *  home-screen app's network without closing its sockets). The /ws socket is
 *  asked (viewerVisibility); a terminal socket that was hidden this long and
 *  heard nothing for as long is simply reopened (its screen replays). */
export const WS_HEARTBEAT_MS = 3_000;
/** cld-gui (U-49): while the page shows, it repeats "showing" to the daemon this often. The daemon counts
 *  a device as looking only for LOOKING_FRESH_MS (core) after the last one, so a phone page that was suspended
 *  (its socket stays open, its timers stop) stops silencing pushes. Well under a third of that window. */
export const LOOKING_BEAT_MS = 10_000;
/** After a reconnect's resync, the replayed waiting/permission states make no
 *  sound for this long: they are not news. */
export const RESYNC_QUIET_MS = 3_000;

// ── Terminal drawer (standalone only) ────────────────────────

// This file is the one place inline colors are allowed (see eslint.config.js),
// which is why xterm's theme lives here rather than next to the component.

// The panel docks on the right as a full-height column, in flow beside the
// office region (which flexes to fill the rest) — not overlaid on top of it.
/** Open width the panel starts at, in px; the user can drag to resize. */
export const TERMINAL_DRAWER_DEFAULT_WIDTH_PX = 520;
/** Clamp for the drag: never narrower than this. */
export const TERMINAL_DRAWER_MIN_WIDTH_PX = 320;
/** Clamp for the drag: never wider than this fraction of the window. */
export const TERMINAL_DRAWER_MAX_WIDTH_RATIO = 0.8;
/** Width of the always-visible agent-card bar overlaying the office's right
 *  edge — fits the bordered container (CARD_BAR_CARD_WIDTH_PX card + 6px
 *  padding and a 2px border each side) and a little air each side. */
export const TERMINAL_SIDEBAR_WIDTH_PX = 120;
/** The desktop card's fixed width: a card never resizes, so the slots stay the same
 *  (owner 10-24: bigger name/status text; the 40px face is unchanged). */
export const CARD_BAR_CARD_WIDTH_PX = 96;
/** WINDOW-LAYERS: the card bar shows this many cards; more scroll inside it. */
export const CARD_BAR_MAX_VISIBLE = 10;
/** Grab width of the drag handle on the panel's left edge. */
export const TERMINAL_DRAWER_RESIZE_HANDLE_PX = 6;
/** "이 터미널로 바꾸기" reads the attach cap with this timeout; a slow answer counts as an unknown cap. */
export const TERMINAL_SWAP_CAP_READ_TIMEOUT_MS = 2_000;
/** A cap refusal this soon after "이 터미널로 바꾸기" means a viewer this window cannot release holds the slot. */
export const TERMINAL_SWAP_REFUSAL_WINDOW_MS = 10_000;

// Mug shot: a square crop of the agent's front-facing sprite, focused on the
// face, shown in each terminal tab in place of an "Agent N" label. Sprites are
// 16 wide × 32 tall; the head runs to about row 18 (eyes ~row 14). The square is
// wider than the 16px sprite, so the head sits centred with a little air.
// Tweak these three to reframe: SIDE = zoom out/in, TOP = raise/lower the crop,
// LEFT = shift left/right (negative centres a square wider than the sprite).
export const MUGSHOT_CROP_TOP_ROW = 0;
export const MUGSHOT_CROP_LEFT_COL = -1;
export const MUGSHOT_CROP_SIDE_PX = 20;
/** Integer sprite-pixel zoom. 2 = each sprite pixel is 2 px. */
export const MUGSHOT_RENDER_ZOOM = 2;
/** The zoom step HD characters ask the camera for (32×64: even zooms); an HD64 character draws
 *  its 32×64 copy at those, so it asks no more. */
export const HD_ZOOM_STEP = 2;
/** The performance readout (Settings): frames averaged, refresh interval. */
export const PERF_FRAMES = 60;
export const PERF_REFRESH_MS = 500;
/** On-screen size in CSS px. Equal to the backing canvas (crop × zoom) so there
 *  is no fractional scaling — the mug shot stays pixel-perfect. */
export const MUGSHOT_DISPLAY_PX = MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM;

// CH-6 pixel editor (꾸미기 → 커스텀): one 16×32 frame zoomed, the sheet small.
export const PIXEL_EDITOR_ZOOM = 12;
export const PIXEL_EDITOR_SHEET_ZOOM = 2;
export const PIXEL_EDITOR_PREVIEW_ZOOM = 3;
export const PIXEL_EDITOR_UNDO_LIMIT = 50;
/** Swatches: the sheet's most used colours, at most this many. */
export const PIXEL_EDITOR_SWATCHES = 16;
export const PIXEL_EDITOR_CHECKER = ['#2b2b3c', '#34344a'] as const;
export const PIXEL_EDITOR_GRID = 'rgba(255, 255, 255, 0.08)';
export const PIXEL_EDITOR_DEFAULT_COLOR = '#000000';
/** The pixel UI font stack (T-0054): FS Pixel Sans for Latin, Galmuri for the
 *  Hangul it lacks (webview-ui/src/fonts.css gives Galmuri a Hangul-only
 *  unicode-range). Canvas text must use this too, and the CSS `--font-pixel`
 *  token in index.css lists the same two families. */
export const PIXEL_FONT_FAMILY = "'FS Pixel Sans', 'Galmuri11'";
/** Canvas text sizes snap to multiples of this: Galmuri11 at its 66.667% size-adjust
 *  (fonts.css) has whole device pixels per font pixel at 18, 36, 54 ... */
export const PIXEL_FONT_CRISP_STEP_PX = 18;
/** Faces to have loaded before the canvas first draws Hangul, as
 *  `document.fonts.load` specs (size is irrelevant, the family and weight pick the face). */
export const PIXEL_FONT_PRELOAD: readonly string[] = ["16px 'Galmuri11'"];
/** A Hangul sample so `document.fonts.load` matches the Galmuri unicode-range. */
export const PIXEL_FONT_PRELOAD_TEXT = String.fromCodePoint(0xac00);
/** Terminal CONTENT is monospace on purpose: FS Pixel Sans is not a mono font,
 *  and a TUI mis-renders in a proportional face. The drawer chrome around it
 *  still uses the pixel font. */
export const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';
export const TERMINAL_FONT_SIZE_PX = 13;
/** Lines xterm retains client-side (independent of the server's replay ring). */
export const TERMINAL_SCROLLBACK_LINES = 5_000;
/** Debounce for propagating a resize to the PTY (fit on every frame thrashes it). */
export const TERMINAL_RESIZE_DEBOUNCE_MS = 100;
/** URL schemes a click in the terminal pane may open (see terminalLinks.ts). */
export const TERMINAL_LINK_PROTOCOLS: readonly string[] = ['http:', 'https:'];
/** window.open features for terminal links: no opener handle, no Referer. */
export const TERMINAL_LINK_WINDOW_FEATURES = 'noopener,noreferrer';
/** THE plain-URL pattern of the terminal pane: TerminalPane hands it to
 *  @xterm/addon-web-links (`urlRegex`) for mouse clicks and urlAtCell matches
 *  it for touch taps, so a URL that is clickable is exactly one that is
 *  tappable. Equivalent to the addon's built-in strictUrlRegex. Deliberately
 *  NOT global: the addon rebuilds it as `new RegExp(source, flags + 'g')`, so
 *  a `g` here would throw on the duplicate flag; matchAll callers make their
 *  own global copy. */
export const TERMINAL_URL_PATTERN =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;
/** Largest OSC 52 clipboard write the terminal honours (clipboardKeys.ts),
 *  in base64 characters (~3 MB of text). Bigger ones are dropped rather than
 *  decoded: a runaway program shouldn't be able to stall the page. */
export const TERMINAL_OSC52_MAX_BASE64_CHARS = 4_000_000;

/** xterm theme, matched to the office palette (index.css :root). */
export const TERMINAL_THEME = {
  background: '#181828',
  foreground: 'rgba(255, 255, 255, 0.9)',
  cursor: '#6030ff',
  cursorAccent: '#181828',
  selectionBackground: 'rgba(96, 48, 255, 0.4)',
  black: '#1e1e2e',
  red: '#d14249',
  green: '#89d185',
  yellow: '#cca700',
  blue: '#3794ff',
  magenta: '#746fff',
  cyan: '#4ad9d9',
  white: 'rgba(255, 255, 255, 0.9)',
  brightBlack: '#4a4a6a',
  brightRed: '#ff6b72',
  brightGreen: '#a8e5a4',
  brightYellow: '#ffd700',
  brightBlue: '#66aaff',
  brightMagenta: '#a29bff',
  brightCyan: '#7fe8e8',
  brightWhite: '#ffffff',
} as const;

// ── Mobile shell ─────────────────────────────────────────────
// Below this the app swaps the desktop drawer layout for the mobile shell:
// office and terminal as full-screen pages in a sliding track, with the agent
// cards in a bottom scroller. Phones match the first clause in either
// orientation; the second catches touch tablets (iPad portrait/landscape)
// where the drag-to-resize drawer is unusable anyway.
export const MOBILE_MEDIA_QUERY = '(max-width: 768px), ((pointer: coarse) and (max-width: 1024px))';
/** Slide duration between the office and terminal pages. */
export const MOBILE_VIEW_TRANSITION_MS = 300;
/** Width of the screen-edge strips that arm the view-switch swipe: right
 *  edge in office view (swipe left → terminal), left edge in terminal view
 *  (swipe right → office). */
export const MOBILE_EDGE_SWIPE_ZONE_PX = 24;
/** Horizontal movement that claims an armed edge touch as a view swipe; it
 *  must also dominate the vertical axis, or the touch is handed back. */
export const MOBILE_EDGE_SWIPE_SLOP_PX = 8;
/** Fraction of the page width past which a released swipe commits. */
export const MOBILE_EDGE_SWIPE_COMMIT_RATIO = 0.35;
/** Release velocity (px/ms) that commits a swipe regardless of distance. */
export const MOBILE_EDGE_SWIPE_COMMIT_VELOCITY = 0.3;
/** Weight of the newest sample in the swipe's smoothed release velocity
 *  (the rest carries over from the previous estimate). */
export const MOBILE_EDGE_SWIPE_VELOCITY_WEIGHT = 0.8;
/** Slightly smaller than the desktop 13px: a 390px phone fits ~46 columns at
 *  13px but ~50 at 12px, and Claude Code's TUI degrades below ~45 columns. */
export const MOBILE_TERMINAL_FONT_SIZE_PX = 12;

// ── Touch input (every surface) ──────────────────────────────
/** Tap slop shared by every touch surface (withinTapSlop): a finger that
 *  travels less than this from where it landed is still a tap; beyond it the
 *  gesture becomes that surface's drag (pan, scroll, reorder). */
export const TOUCH_TAP_MAX_MOVE_PX = 10;
/** A press longer than this is not a tap even if the finger never moved. */
export const TOUCH_TAP_MAX_DURATION_MS = 350;
/** G1: a finger held still this long on the office opens the character menu. */
export const CANVAS_LONG_PRESS_MS = 500;

// ── Terminal touch (touchGesture.ts, selectionOverlay.ts, flowCopy.ts) ──
/** Hold a finger within the tap slop for this long on the terminal to start
 *  text selection instead of scrolling: the word under the finger is
 *  selected, and dragging then extends the selection cell by cell. */
export const TERMINAL_LONG_PRESS_MS = 500;
/** Vertical gap between the selection's top row and the floating copy pill
 *  hovering above it (clears the start handle's knob). */
export const TERMINAL_COPY_PILL_GAP_PX = 56;
/** The copy pill's center stays at least this far from the pane's left and
 *  right edges — or half its measured width, when that is more — so it is
 *  never clipped. */
export const TERMINAL_COPY_PILL_EDGE_INSET_X_PX = 44;
/** The copy pill's top stays at least this far above the pane's bottom edge
 *  (its own height plus a margin). */
export const TERMINAL_COPY_PILL_BOTTOM_CLEARANCE_PX = 48;
/** The copy pill's top never goes above this; a pill that would (selection
 *  near the top of the pane) drops below the selection instead. */
export const TERMINAL_COPY_PILL_MIN_TOP_PX = 4;
/** Gap below the selection's last row when the pill drops beneath it (clears
 *  the end handle's knob). */
export const TERMINAL_COPY_PILL_BELOW_OFFSET_PX = 16;
/** Width of a selection handle's touch strip, centered on the selection edge.
 *  Feeds the `.terminal-sel-handle` CSS through --sel-handle-w. */
export const TERMINAL_SEL_HANDLE_WIDTH_PX = 24;
/** Side of a selection handle's square knob (above the start bar, below the
 *  end bar). Feeds the `.terminal-sel-handle` CSS through --sel-knob. */
export const TERMINAL_SEL_HANDLE_KNOB_PX = 12;
/** Copy-flowing (flowCopy.ts) judges "the next word would not have fit on
 *  the row above" against `cols` minus this: Claude Code wraps prose a few
 *  columns short of the terminal width (its own gutters). Too small and real
 *  soft wraps stay broken; too large and short deliberate lines get joined. */
export const TERMINAL_COPY_WRAP_SLACK_COLS = 4;
/** Flick decay after a terminal touch-scroll release, applied per millisecond
 *  of frame time (0.998 ≈ iOS UIScrollView's normal deceleration rate). */
export const TERMINAL_FLICK_DECAY_PER_MS = 0.998;
/** Release velocity (px/ms) below which no flick starts and at which a
 *  running flick stops. */
export const TERMINAL_FLICK_MIN_VELOCITY_PX_PER_MS = 0.05;
/** Exponential smoothing of the touch-scroll velocity: weight of the newest
 *  move's sample (the running value keeps the rest). The release velocity
 *  comes from the last move event, which is noisy on its own. */
export const TERMINAL_FLICK_VELOCITY_SMOOTHING = 0.8;
/** xterm's cell-grid element: hit-testing, row height and the selection
 *  chrome all measure THIS rect (not the host, which keeps up to a row of
 *  slack below the grid after fit). */
export const XTERM_SCREEN_SELECTOR = '.xterm-screen';
/** Class of xterm's hidden input textarea — focused while typing into a
 *  terminal (see isTypingInTerminal). */
export const XTERM_HELPER_TEXTAREA_CLASS = 'xterm-helper-textarea';

// ── Mobile card bar (MobileAgentBar) ─────────────────────────
/** Holding a card motionless this long arms drag-to-reorder in the mobile bar. */
export const CARD_REORDER_LONG_PRESS_MS = 400;
/** Holding a drawer's Directory row this long opens its edit modal — the touch
 *  stand-in for the pencil, which only exists where rows can be hovered. */
export const DRAWER_EDIT_LONG_PRESS_MS = 500;
/** Finger slop for that hold: moving beyond this is a scroll, not a press. */
export const DRAWER_EDIT_LONG_PRESS_MAX_MOVE_PX = 10;
/** MSG-ACTIONS: holding a messenger bubble this long opens its action sheet (복사 · 답글) on a phone. */
export const MESSAGE_ACTIONS_LONG_PRESS_MS = 500;
/** Gap a viewport-fitted Dropdown (the launch drawer) keeps from the top of
 *  the viewport when its content is taller than the room above its anchor. */
export const DROPDOWN_VIEWPORT_MARGIN_PX = 8;
/** localStorage key for the mobile bar's custom card order (per device — a
 *  presentation preference, deliberately not synced through the server). */
export const MOBILE_CARD_ORDER_STORAGE_KEY = 'pixel-agents.mobileCardOrder';
/** localStorage key: this device opened the mobile bar's full cards (compact otherwise). */
export const MOBILE_CARDS_EXPANDED_STORAGE_KEY = 'cld.mobile-cards-expanded';
/** Breathing room kept between a card and the scroller edge when the bar
 *  auto-scrolls the focused agent's card into view. */
export const CARD_SCROLL_INTO_VIEW_MARGIN_PX = 8;

// ── Mobile key bar (MobileKeyBar) ────────────────────────────
/** Byte sequences the key bar writes to the PTY (xterm's, normal cursor mode). */
export const TERMINAL_SEQ_ARROW_UP = '\x1b[A';
export const TERMINAL_SEQ_ARROW_DOWN = '\x1b[B';
export const TERMINAL_SEQ_ARROW_RIGHT = '\x1b[C';
export const TERMINAL_SEQ_ARROW_LEFT = '\x1b[D';
export const TERMINAL_SEQ_INSERT = '\x1b[2~';
export const TERMINAL_SEQ_DELETE = '\x1b[3~';
export const TERMINAL_SEQ_HOME = '\x1b[H';
export const TERMINAL_SEQ_END = '\x1b[F';
export const TERMINAL_SEQ_PAGE_UP = '\x1b[5~';
export const TERMINAL_SEQ_PAGE_DOWN = '\x1b[6~';
export const TERMINAL_SEQ_ENTER = '\r';
export const TERMINAL_SEQ_ESC = '\x1b';
export const TERMINAL_SEQ_TAB = '\t';
/** Shift+Tab: CSI Z (back-tab), Claude Code's mode cycle. */
export const TERMINAL_SEQ_BACK_TAB = '\x1b[Z';
/** Line break without submitting: Claude Code's backslash+Enter escape, its universal form
 *  (shift+enter needs a /terminal-setup rebind that can't exist on a phone keyboard). */
export const TERMINAL_SEQ_NEWLINE = '\\\r';
/** The key bar's sticky one-shot modifiers. */
export type MobileKeyModifier = 'ctrl' | 'shift';
/** Height of one key-bar key. Kept compact on purpose (two rows over a terminal the owner tuned
 *  10-24): the bar opts out of the 44 px phone touch rule with `data-touch-compact`. */
export const MOBILE_KEY_HEIGHT_PX = 30;
/** Width of the arrow keys (and Tab / paste beside the up arrow) at the bar's right end. */
export const MOBILE_ARROW_KEY_WIDTH_PX = 40;
/** Finger travel per emitted arrow while sliding from an arrow key (the old trackpad gesture). */
export const MOBILE_TRACKPAD_STEP_PX = 16;
/** The paste key's prompt where script can't read the clipboard (plain-http
 *  origins): the user pastes into the native field instead. */
export const MOBILE_PASTE_PROMPT = 'Paste into the terminal:';
/** visualViewport.height within this many px of innerHeight = nothing to
 *  clamp (the two disagree by sub-pixel rounding on some devices). */
export const VISUAL_VIEWPORT_FULL_EPSILON_PX = 1;
/** The visual viewport this far below the tallest seen at the current width
 *  (with an editable focused) = the software keyboard is up. Well above an
 *  address bar collapsing (~56 px), well below any on-screen keyboard. */
export const KEYBOARD_MIN_HEIGHT_PX = 150;
/** A messenger history/search request the daemon never answers is given up after this. */
export const CHAT_REQUEST_TIMEOUT_MS = 20_000;

// ── ISO-PILOT: the isometric building (cld/iso) ─────────────────
/** Half a floor diamond (iso px at zoom 1): a 16 px world tile is a 16×8 diamond, so a 16×32
 *  character stands about four tiles tall, the proportions the top-down office has. */
export const ISO_HALF_W = 8;
export const ISO_HALF_H = 4;
/** A tall back wall (iso px above its floor), a cut-away wall, a floor slab, and the gap left
 *  between a floor's wall tops and the slab of the floor above. */
export const ISO_WALL_H = 40;
export const ISO_LOW_WALL_H = 5;
export const ISO_SLAB_H = 6;
export const ISO_FLOOR_GAP = 6;
/** Margin (iso px) around the building in the whole-building framing. */
export const ISO_FRAME_MARGIN = 12;
/** A floor not in focus: drawn from its cache darkened by this wash, at this opacity. */
export const ISO_DIM_WASH = 'rgba(14, 18, 38, 0.5)';
export const ISO_DIM_ALPHA = 0.82;
/** How often a dimmed floor checks whether its characters moved (ms; redrawn only then). */
export const ISO_DIM_REFRESH_MS = 1000;
/** Half-extent (tiles) of the depth box a character stands in. */
export const ISO_CHARACTER_BOX = 0.3;
/** World px a seated character's feet move towards its desk. */
export const ISO_SIT_FORWARD_PX = 3;
/** The isometric elevator car's speed, floors a second. */
export const ISO_LIFT_LEVELS_PER_S = 2.5;
/** World px a picture hung on a wall drops when that wall is cut away (it rests on its top). */
export const ISO_LOW_WALL_ITEM_DROP = 5;
