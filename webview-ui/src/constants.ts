import { CHAR_COUNT } from '../../core/src/assets/constants.js';
import type { ColorValue } from './components/ui/types.js';

// ── Desktop bridge ──────────────────────────────────────────
export const ADMIN_SETUP_COMMAND = 'run_admin_setup';
/** The desktop app's window command (lib.rs toggle_fullscreen, allowed for the office by office-keys). */
export const TOGGLE_FULLSCREEN_COMMAND = 'toggle_fullscreen';
/** DESKTOP-ACTIONS: the window event the desktop app fires when a download ends (lib.rs on_download). */
export const APP_DOWNLOAD_EVENT = 'agent-tycoon-download';

// ── Messenger ───────────────────────────────────────────────
export const ATTACH_ACCEPT =
  'image/*,video/*,.mp4,.mov,.m4v,.webm,.pdf,.txt,.md,.csv,.json,.log,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.hpp,.cs,.sh,.bash,.zsh,.css,.html,.xml,.yaml,.yml,.sql,.toml,.zip,.7z,.tar,.gz,.tgz,.docx,.xlsx,.pptx,.odt,.ods,.odp,.doc,.xls,.ppt,.hwp,.hwpx,.rtf';

/** A video is held on the daemon's disk, not in memory: its own, larger limit (the daemon's VIDEO_ATTACH_MAX). */
export const ATTACH_VIDEO_MAX_BYTES = 300 * 1024 * 1024;
/** A video whose ticket the server refused (it ran out) is asked for again this many times. */
export const ATTACH_VIDEO_TICKET_RETRIES = 1;

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
/** WALK-FIX: a walk frame lasts this many world px walked (half a tile), counted over a
 *  character's whole life, so a one-tile tap shows one step and the next tap the other
 *  (a timer reset at every walk start showed the same step every tap, owner 11-01 20:59). */
export const WALK_STRIDE_PX = 8;
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
/** GFX e2e: the one-sprite-px marker of the synthetic HD character (testHooks makeHdCharacter). */
export const HD_TEST_MARKER_COLOR = '#FFFFFF';
/** GFX title scene: over the HUD (48-49), under the dialogs (50+) its menu opens. */
export const TITLE_SCENE_Z = 49;
/** BOOT-LOAD: the loading screen in front of the lobby, its steps in order with their weight (their
 *  share of the bar, about the time each takes on a phone). */
export const BOOT_STEPS = [
  { id: 'connect', weight: 1 },
  { id: 'office', weight: 2 },
  { id: 'fonts', weight: 1 },
  { id: 'lobby', weight: 2 },
  { id: 'looks', weight: 3 },
  { id: 'iso', weight: 2 },
  { id: 'warm', weight: 4 },
  { id: 'frame', weight: 1 },
] as const;
/** BOOT-LOAD: a step still waiting this long after the start is skipped (it carries on behind the
 *  lobby, as before); the daemon's steps are never skipped. */
export const BOOT_GIVE_UP_MS = 15_000;
/** BOOT-LOAD: no daemon this long after the start: the retry panel shows (the socket keeps trying). */
export const BOOT_ALERT_MS = 8_000;
/** BOOT-LOAD: queued pictures built per animation frame while the loading screen shows (nothing
 *  else moves then; the office's own slice is WARM_SLICE_MS). */
export const BOOT_WARM_SLICE_MS = 12;
/** BOOT-LOAD: navigator.deviceMemory (GB) at or under this, or a phone: only the zoom shown warms. */
export const BOOT_LEAN_MEMORY_GB = 4;
/** BOOT-LOAD: the bar's cells (5 % each). */
export const BOOT_BAR_SEGMENTS = 20;
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
/** Suggested filename when exporting the office layout from the standalone browser.
 *  Import takes any JSON file, so files saved under the old pixel-agents-layout.json name still load. */
export const LAYOUT_EXPORT_FILENAME = 'agent-tycoon-layout.json';
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

// ── Job Sound (agty T-0039: a job or Codex task finished) ──
export const JOB_NOTES_HZ = [1046.5, 1318.51, 1567.98]; // C6 E6 G6
export const JOB_NOTE_STEP_SEC = 0.08;
export const JOB_NOTE_DURATION_SEC = 0.14;
export const JOB_VOLUME = 0.1;

// ── Notices (agty T-0039: toast, pulse, bell) ───────────
/** The bell keeps this many notices. */
export const NOTICE_LIST_MAX = 50;
export const NOTICE_TOAST_MS = 6_000;
/** How long the character pulses, and one pulse's length. */
export const NOTICE_PULSE_MS = 3_000;
/** A notice jump waits this long for a message that has not reached the conversation yet. */
export const JUMP_WAIT_MS = 5_000;
/** CHAT-NAV: older messages are asked for when the top is this close, so a page lands while the reader
 *  is still mid-list (not in the rubber band at the very top, where a phone ignores a scroll set). */
export const HISTORY_PREFETCH_PX = 400;
/** The return button goes away once the reader is within this part of a screen of where the jump left. */
export const RETURN_NEAR_RATIO = 0.5;
/** CHAT-NAV: a scroll position within this many px of the wanted one is left alone (setting it would
 *  stop a phone's momentum for nothing). */
export const SCROLL_HOLD_SLACK_PX = 1;
/** agty (T-0043): a turn end and a messenger reply this close together are one notice. */
export const NOTICE_PAIR_MS = 15_000;
export const NOTICE_PULSE_PERIOD_MS = 1_000;
export const NOTICE_PULSE_COLOR = '#ffd84a';
export const NOTICE_DEFAULT_VOLUME = 0.8;
/** NOTICE-B: the sender's face in a 알림 row (inside a 2px frame, so the slot is 36). */
export const NOTICE_FACE_PX = 32;

// ── The lobby board (agty T-0046) ─────────────────────────
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
/** News lines on the board's 요약 page (A5). */
export const BOARD_SUMMARY_FEED_ROWS = 6;
/** H/W graphs cover the last 60 s (hwSample comes every 2 s while anyone views). */
export const BOARD_HISTORY_MS = 60_000;
export const BOARD_HISTORY_SAMPLES = 40;
/** Disk-card sizes use binary steps while displaying the familiar KB/MB/GB suffixes. */
export const DISK_BYTES_PER_KIB = 1_024;
export const DISK_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
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

// ── Whiteboard memos (agty T-0065) ─────────────────────────
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
/** The tycoon office keeps "seen the update log of this version" per browser (a read-only viewer cannot save it on the host). */
export const CHANGELOG_SEEN_STORAGE_KEY = 'cld.changelogSeen';

// ── Game Logic ───────────────────────────────────────────────
export const MAX_DELTA_TIME_SEC = 0.1;
/** agty (T-0075): the office canvas, and the overlays that share its pacer,
 *  draw this often while nothing on it moves (the typing and reading frames
 *  change slower than that, so idle characters look the same). Motion, and
 *  input on the office, take it back to the full frame rate on the very frame
 *  they start. */
export const OFFICE_IDLE_FPS = 10;
/** PAGE-MEM (owner 11-04 21:13: CPU 15 %, GPU 23 % with nobody using it): with no input, when only
 *  characters move on their own (a walk, a waiting bubble, a pet), the office draws this often;
 *  input, the camera and effects keep the full rate. */
export const OFFICE_AMBIENT_FPS = 30;
/** How long after the last pointer, touch, wheel or key input the office keeps
 *  drawing at the full rate (a hover, a drag, a key walk about to begin). */
export const OFFICE_INPUT_GRACE_MS = 800;
/** The office counts as on screen from this share of the canvas visible. */
export const OFFICE_VISIBLE_RATIO = 0.001;
export const WAITING_BUBBLE_DURATION_SEC = 2.0;
export const DISMISS_BUBBLE_FAST_FADE_SEC = 0.3;
export const INACTIVE_SEAT_TIMER_MIN_SEC = 3.0;
export const INACTIVE_SEAT_TIMER_RANGE_SEC = 2.0;
/** Default/fallback palette count (bundled characters, core's `CHAR_COUNT`). Actual count comes from getLoadedCharacterCount(). */
export const PALETTE_COUNT = CHAR_COUNT;
/** DIAG-1104: built-in person i's three-quarter sheet draws under palette DIAG_PALETTE_BASE + i
 *  (below looks.ts's preset palettes, 1000 up). */
export const DIAG_PALETTE_BASE = 500;
export const AUTO_ON_FACING_DEPTH = 3;
export const AUTO_ON_SIDE_DEPTH = 2;
export const CHARACTER_HIT_HALF_WIDTH = 8;
export const CHARACTER_HIT_HEIGHT = 24;
export const TOOL_OVERLAY_VERTICAL_OFFSET = 32;

// ── Greeter + Intro bubble ──────────────────────────────────
/** Reserved character id for the Intro's greeter. Far outside both real agent
 *  ids (positive) and sub-agent ids (small negatives from -1 down). */
export const GREETER_ID = -1_000_000_000;
/** OWNER-AVATAR: the owner's own walking character (not an agent). Below every virtual id
 *  (officeStore.virtualAgentId counts down from -1_000_000_000). */
export const OWNER_CHARACTER_ID = -2_000_000_000;
/** FX-ALL: the key (by position) that has the owner's character drink at the machine it stands by. */
export const OWNER_DRINK_KEY = 'KeyE';
/** Where it starts: tiles from the lobby board's anchor, in front of the board's middle. */
export const OWNER_SPAWN_FROM_BOARD = { col: 14, row: 11 } as const;
/** ...or, with no board (it stands outside the building), this many rows up from floor 1's last
 *  row (its office door), in the middle. */
export const OWNER_SPAWN_FROM_DOOR_ROWS = 3;
/** Stacking order for the Intro's bubble. Deliberately BELOW the modal stack
 *  (ui/Modal defaults to 50, ChangelogModal 51, the migration notice z-100): the
 *  Intro is diegetic furniture over the office, not a modal, so a modal opened
 *  on top of it must cover it rather than slide underneath. */
export const INTRO_BUBBLE_Z_INDEX = 45;
/** O4: how long a saved skip-permissions choice may wait for the server's confirmation before the Intro's buttons come back. */
export const BYPASS_ANSWER_TIMEOUT_MS = 6000;
/** ToolOverlay stacking: status label panels (selected one on top), then the
 *  characters' speech bubbles above every label — all below the Intro bubble. */
/** WINDOW-LAYERS (owner 10-25; 11-06 20:57: what was clicked last is in front): the HUD layer's z scale,
 *  bottom to top. The pop-up notices; one stack of the windows and the HUD panels (the elevator column, the
 *  corner, the party, the control center, the dock), `stack` + its place in windowModel's order, a press on
 *  one brings it to the top, and what a panel opens (the notification list, usage, the menu, the member card)
 *  rides with it; a maximized window from `maximized`, over the whole stack; the dock's handle over it
 *  (hud-v3 P0). Dialogs, the step-up and the phone sheets portal to the body, over the whole layer
 *  (HudIcons HUD_LAYER_Z); the canvas world is under it. */
export const HUD_Z = { toasts: 0, stack: 10, maximized: 40, dockOverMax: 60 } as const;
/** hud-v3: the band at the bottom a normal window keeps clear of, so the floating dock never covers its composer
 *  or buttons (a maximized window still fills the room; its body pads the handle's height). The folded control
 *  center (hud/ControlCenter.tsx, 154-166 tall) is a panel like the party: a window moved into the bottom-left
 *  corner and the control center take turns in front, whichever was pressed last (HUD_Z). */
export const HUD_DOCK_RESERVE_PX = 120;
/** The folded dock's handle (24 px and its frame) plus air: a maximized window's body pads this much at its foot. */
export const HUD_DOCK_HANDLE_PX = 32;
/** hud-v3 (owner 11-06): the inspector, placed beside its portrait, keeps the same band clear (the dock). */
export const HUD_BOTTOM_RESERVE_PX = HUD_DOCK_RESERVE_PX;
/** hud-v3 P0: the top-right row (the CPU heat when hot) over the party: its height and the gap under it. */
export const HUD_CORNER_ROW_PX = 44;
/** The event log keeps this many recent events. */
export const HUD_EVENT_LOG_MAX = 30;
/** SMOOTH2-1104: the DOM overlays' content re-renders at least this often (the net under the change signature). */
export const OVERLAY_CONTENT_MS = 100;
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
 * name/level: fonts; ring: the XP ring's outer size; fatigue: the 피로도 row's font
 * (the opened plate's and 미확인's), barHeight/bar: the plate's 피로도 bar, its height and fixed width
 * (T-67: the row is "피로도 [bar] 휴식 1/2"); rank/status: CSS px per sprite pixel of the
 * rank icon and of the status icon (zzz, !, lock); card: every plate's one width per screen style
 * (T-67, owner 11-06 22:34: what the owner's sample name, Samwise Gamgee in Hangul, needs in that style's
 * name font beside the rank icon and the XP ring, the larger of Chromium and WebKit rounded up, plus 1 px;
 * measured by cld/test/run-office-nameplate-fixed.ts MEASURE=1); a longer name ends in an ellipsis. The bar
 * is as long as lets "피로도 [bar] 휴식 1/2" fit that width in both styles. Owner 11-06 23:11: the bar read too
 * small, so each card is ~20% wider (+20/+22/+28 px) and all of it went to the bar.
 */
export const NAMEPLATE_SIZES = {
  small: {
    name: 14,
    level: 14,
    ring: 18,
    fatigue: 12,
    barHeight: 4,
    bar: 46,
    rank: 2,
    status: 1,
    card: { modern: 121, pixel: 126 },
  },
  medium: {
    name: 14,
    level: 14,
    ring: 20,
    fatigue: 14,
    barHeight: 6,
    bar: 50,
    rank: 2,
    status: 2,
    card: { modern: 134, pixel: 132 },
  },
  large: {
    name: 18,
    level: 18,
    ring: 24,
    fatigue: 18,
    barHeight: 6,
    bar: 64,
    rank: 3,
    status: 2,
    card: { modern: 170, pixel: 168 },
  },
} as const;
/** UI-SCALE: --ui-scale per 화면 크기 step: Tailwind's spacing and text sizes (index.css) times this. */
export const UI_SCALE_FACTORS = { small: 0.875, medium: 1, large: 1.25 } as const;
/** A plate that overlaps another (and is neither selected nor hovered) shows at this opacity. */
export const NAMEPLATE_OVERLAP_OPACITY = 0.6;
/** UI-PHONE: while an agent's summary card is open on the phone, every other plate is drawn at
 *  this opacity, so the card and its menu row read clearly over them. */
export const PHONE_CARD_OTHERS_ALPHA = 0.3;
/** Plates overlapping by this much or less (their borders and padding) count as apart: no text is covered. */
export const NAMEPLATE_OVERLAP_SLOP_PX = 4;
/** The overlap pass runs at most this often (and at once on selection, hover and resize). */
export const NAMEPLATE_PASS_MS = 200;

/** The room the crowd pass leaves between a nudged plate and what it was stacked against, px. */
export const NAMEPLATE_CROWD_GAP_PX = 2;
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
/** PARTY-FRAME: '1' when this device keeps the elevator's floor list open beside its ▲ 1F ▼ strip. */
export const ELEVATOR_LIST_OPEN_STORAGE_KEY = 'cld.elevator-list-open';
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
// cld LOUNGE (cld/lounge.ts): off duty, orchestrators rest in the lounge instead of leaving.
/** A resting character walks to a machine for a drink once in this many seconds, at random (game s). */
export const LOUNGE_DRINK_MIN_SEC = 150;
export const LOUNGE_DRINK_MAX_SEC = 330;
/** What a machine plays while someone gets a drink: seconds per state (coffee: cup, pouring, done;
 *  vending: lit, button, can in the tray; water: filling the cup, no picture of its own). */
export const LOUNGE_USE_SEC = {
  coffee: [1, 2.4, 1.2],
  vending: [0.8, 0.7, 1.2],
  water: [1.6],
} as const;
/** The drinking sequence has seven steps (the owner's references), this long each (game s). */
export const LOUNGE_DRINK_STEPS = 7;
export const LOUNGE_DRINK_STEP_SEC = 0.9;
/** A character dropped on a blocked spot settles on the nearest free tile within this many tiles. */
export const LOUNGE_DROP_NEAR_TILES = 3;
/** Seconds per zzz frame while dozing (slower than the status icon's). */
export const LOUNGE_ZZZ_FRAME_SEC = 1.4;
/** A classic 16x32 figure is this tall (px, feet to the top of its head): the unit the drink's
 *  positions are written in (cld/lounge.ts drinkPose), scaled to a taller figure's drawn height. */
export const LOUNGE_FIGURE_PX = 26;
/** C1 (owner 11-01 "김 모락모락"): hot coffee's steam, drawn in code (cld/steam.ts): `STEAM_WISPS`
 *  wisps side by side (`STEAM_SPREAD_PX` apart), each a stream of `STEAM_PUFFS` soft puffs that
 *  rise `STEAM_RISE_PX` in `STEAM_PERIOD_SEC`, sway up to `STEAM_SWAY_PX` (`STEAM_SWAY_WAVES` half
 *  waves on the way up), grow `STEAM_GROW` times their `STEAM_RADIUS_PX` and fade in and out
 *  (at most `STEAM_ALPHA`). World px. */
export const STEAM_WISPS = 3;
export const STEAM_SPREAD_PX = 2.4;
export const STEAM_PUFFS = 6;
export const STEAM_RISE_PX = 14;
export const STEAM_PERIOD_SEC = 2.6;
export const STEAM_SWAY_PX = 1.4;
export const STEAM_SWAY_WAVES = 2;
/** Each wisp sways this much of a half wave after the one before it. */
export const STEAM_WISP_PHASE = 0.7;
export const STEAM_RADIUS_PX = 2;
export const STEAM_GROW = 1.8;
export const STEAM_ALPHA = 0.8;
export const STEAM_COLOR = 'rgba(255, 255, 255, 1)';
export const STEAM_CLEAR = 'rgba(255, 255, 255, 0)';
/** A held cup's steam drifts this far sideways over its rise, away from the figure's middle (the
 *  face over the cup), every wisp starting on that side. World px. */
export const STEAM_HELD_LEAN_PX = 10;
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
// ── Agent CLI restart notice ────────────────────────────────
/** The usual daemon-helper restart time shown by the plain-office notice. */
export const AGENT_CLI_RESTART_EXPECTED_MS = 60_000;
/** After this long the notice tells the owner where to reconnect from. */
export const AGENT_CLI_RESTART_SLOW_MS = 180_000;
/** Health requests only run after the old daemon's WebSocket has dropped. */
export const AGENT_CLI_RESTART_HEALTH_POLL_MS = 2_000;
export const AGENT_CLI_RESTART_CLOCK_MS = 1_000;
/** Do not keep polling after the slow-restart threshold. */
export const AGENT_CLI_RESTART_HEALTH_MAX_ATTEMPTS =
  AGENT_CLI_RESTART_SLOW_MS / AGENT_CLI_RESTART_HEALTH_POLL_MS;
/** A restart that takes longer than expected stops visibly short of completion. */
export const AGENT_CLI_RESTART_PROGRESS_MAX_PERCENT = 92;
export const AGENT_CLI_RESTART_PROGRESS_BORDER_PX = 2;
export const AGENT_CLI_RESTART_PROGRESS_HEIGHT_PX = 12;
export const AGENT_CLI_RESTART_PROGRESS_RADIUS_PX = 0;
export const AGENT_CLI_RESTART_PROGRESS_ARIA_MIN = 0;
export const AGENT_CLI_RESTART_PROGRESS_ARIA_MAX = 100;
export const AGENT_CLI_RESTART_PROGRESS_BORDER_COLOR = '#1f2937';
export const AGENT_CLI_RESTART_PROGRESS_FILL_COLOR = '#38bdf8';
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
/** The owner's "나" plate (a hot pink-orange fill, dark text) so it never reads as an agent's plate. */
export const OWNER_PLATE_BG = '#ff7a2f';
export const OWNER_PLATE_FG = '#1a1020';

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
/** agty (T-0025): coming back to the foreground, a socket that stays silent
 *  this long is taken for dead and replaced at once (iOS cuts a backgrounded
 *  home-screen app's network without closing its sockets). The /ws socket is
 *  asked (viewerVisibility); a terminal socket that was hidden this long and
 *  heard nothing for as long is simply reopened (its screen replays). */
export const WS_HEARTBEAT_MS = 3_000;
/** agty (U-49): while the page shows, it repeats "showing" to the daemon this often. The daemon counts
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
/** PARTY-FRAME (owner 11-04 (나)): the folded card bar's width, a 56px portrait plus the container's
 *  4px padding and 2px border each side and 2px of air. */
export const PARTY_FRAME_BAR_PX = 72;
/** FEAT-PARTY-V2: the party this device shows (the parties themselves are the daemon's, parties.json). */
export const PARTY_SELECTED_STORAGE_KEY = 'cld.party-selected';
/** T-71: sub-agent icons under a Lead's portrait; past this many the last one reads +N. */
export const PARTY_SUB_ICONS_MAX = 3;
/** The member card's 기록 tab: the latest notices about the agent. */
export const MEMBER_CARD_LOG_ROWS = 6;
/** The member card's 관련 이슈: this many Tasks, then "외 N". */
export const MEMBER_CARD_TASK_ROWS = 4;
/** The phone's member sheet: over the office's labels (41-43), under a modal (50) so its confirmations cover it. */
export const MEMBER_SHEET_Z = 48;
/** WINDOW-LAYERS: the card bar shows this many cards; more scroll inside it. */
export const CARD_BAR_MAX_VISIBLE = 10;
/** Grab width of the drag handle on the panel's left edge. */
export const TERMINAL_DRAWER_RESIZE_HANDLE_PX = 6;

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
/** PAGE-MEM (owner 11-04 21:13, 2 GB in the desktop app): every picture the office builds from
 *  sprites and can build again (each zoom's character and furniture frames, the detailed
 *  characters' pictures and mip levels) shares this many bytes, least recently used let go first
 *  (office/sprites/pictureBudget.ts). The pixels and what each picture costs besides them. */
export const PICTURE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Measured in headless Chromium (11-04): a small canvas costs ~28 KB besides its pixels (its
 *  2D context and surface), an ImageBitmap ~7 KB. */
export const PICTURE_CANVAS_OVERHEAD_BYTES = 28 * 1024;
export const PICTURE_BITMAP_OVERHEAD_BYTES = 7 * 1024;
/** SHEET-IMPORT: a drawn frame and the queued pictures built after it (warm-up) take at most
 *  this long together; an idle callback leaves this much of its time unused. */
export const WARM_SLICE_MS = 6;
export const WARM_IDLE_SPARE_MS = 4;
/** SHEET-IMPORT: frames that leave no time over still run one queued build every this many. */
export const WARM_FORCE_EVERY = 4;
/** SHEET-IMPORT: an imported sheet (density 12) and the proxy its frames carry for hit tests,
 *  outlines and the spawn effect (density 4: 64×128). */
export const IMPORT_DENSITY = 12;
export const IMPORT_PROXY_DENSITY = 4;
/** PAGE-MEM: an imported sheet the office wears is kept at the density its closest zoom draws
 *  (ZOOM_MAX device px per world px), not its own 12: 0.69 of the pixels, as sharp at every zoom. */
export const IMPORT_MASTER_DENSITY = ZOOM_MAX;
/** PERF-WEBVIEW-MEMORY: a worn sheet's masters drawn only at half their density or less are kept
 *  halved (smoothSprite.ts), never smaller: no zoom up to ZOOM_MAX / 2 has to decode one again. */
export const SHEET_MASTER_MIN_SCALE = 1 / 2;
/** ...once the office has not drawn it larger than that for this long (after a close zoom, one
 *  more close zoom soon would decode it again). */
export const SHEET_MASTER_SHRINK_MS = 60_000;
/** SHEET-IMPORT (owner 10-26 03:10): an imported character's world frame (24×44 px, its standing
 *  figure 1.3 classic ones tall), and the density the 64×128 pack characters draw at (3: 1.33
 *  times their 16×32 world size, as tall as an imported one). */
export const IMPORT_WORLD_W = 24;
export const IMPORT_WORLD_H = 44;
/** C1: an iso8 sheet with the drinking poses has a 6th row (5 without); its first 6 cells are
 *  coffee lifted, sipping, sipping with eyes closed, then the same with a can. */
export const ISO8_DRINK_ROWS = 6;
export const ISO8_DRINK_CELLS = 6;
export const HD64_DRAW_DENSITY = 3;
/** A classic figure's head is this many world px over its feet: a taller character's labels,
 *  bubbles, icons and hit box rise by what its own figure stands over it. */
export const CLASSIC_FIGURE_RISE = 30;
/** SHEET-IMPORT: the figures' boxes over the source sheet in the import window. */
export const SHEET_BOX_COLOR = '#00e5ff';
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
/** UI-FONT 읽기 쉬움: Galmuri11 answers for printable ASCII first (fonts.css 'Galmuri11 ASCII'). */
export const PIXEL_FONT_FAMILY_READABLE = `'Galmuri11 ASCII', ${PIXEL_FONT_FAMILY}`;
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
/** MOBILE-SWIPE: a touch starting this close to either side edge would be iOS's Back/Forward
 *  swipe, so its touchstart is cancelled (mobile/phoneHistory.ts). */
export const MOBILE_HISTORY_EDGE_PX = 16;
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
/** MSG-POLISH: the quote peek over the composer is at most this tall (px), less where the list is shorter. */
export const QUOTE_PEEK_MAX_PX = 256;
/** MSG-SPLIT: the desktop messenger's width from which 2 or 2×2 conversations fit beside its list. */
export const MESSENGER_SPLIT_MIN_PX = 960;
/** ROOM-THREADS: a tagged room post still unanswered shows its thread's waiting rail this long. */
export const ROOM_WAITING_MS = 24 * 60 * 60 * 1000;
/** ROOM-FOLD: the browser setting that remembers which threads are folded, and how many of them it keeps. */
export const ROOM_FOLD_KEY = 'cld.room-thread-fold';
export const ROOM_FOLD_MAX = 300;
// GAME-UI-1 G1 (ideas/messenger 01, 02, 04): the messenger's game motion.
/** 01: every sentence of a new reply takes this long to type (an English line has more characters than a
 *  Korean one, so the time follows the sentences, and inside one sentence the characters share it evenly) ... */
export const MSG_TYPE_SENTENCE_MS = 533;
/** 01: ... but the whole reply never takes longer than this (a long answer types faster, not longer) ... */
export const MSG_TYPE_MAX_MS = 5000;
/** 01: ... in whole characters every tick. */
export const MSG_TYPE_TICK_MS = 40;
/** 01: the portrait in its dialogue frame, the lead's and the boss's alike (75% of the earlier 48/60) ... */
export const MSG_PORTRAIT_PX = 33;
/** ... and what the frame adds around it (4 px padding and a 2 px line a side). */
export const MSG_PORTRAIT_FRAME_PAD_PX = 12;
/** 02: a confirmed answer's stamp stays on its card this long, then the card folds into a record. */
export const MSG_QUEST_HOLD_MS = 1300;
/** 02: the fold's three steps. */
export const MSG_QUEST_FOLD_MS = 210;
/** 02: a question card shows at most this many sentences of the lead's last paragraph (its end). */
export const MSG_QUESTION_SENTENCES = 3;
/** A reply of more than this many sentences folds behind 더 보기 (about the 12 lines it folded at before). */
export const MSG_FOLD_SENTENCES = 8;
/** 02: folded records kept per conversation (this page only). */
export const MSG_QUEST_RECORDS_MAX = 20;
/** 04: the row's ✓ 전달됨 badge, after which its time shows again. */
export const MSG_DELIVERED_BADGE_MS = 1600;
/** Gap a viewport-fitted Dropdown (the launch drawer) keeps from the top of
 *  the viewport when its content is taller than the room above its anchor. */
export const DROPDOWN_VIEWPORT_MARGIN_PX = 8;
/** localStorage key for the mobile bar's custom card order (per device — a
 *  presentation preference, deliberately not synced through the server). */
export const MOBILE_CARD_ORDER_STORAGE_KEY = 'agent-tycoon.mobileCardOrder';
/** The same key before the 2026-11 rename, still read when the new one is unset. */
export const LEGACY_MOBILE_CARD_ORDER_STORAGE_KEY = 'pixel-agents.mobileCardOrder';
/** localStorage key: this device opened the mobile bar's full cards (compact otherwise). */
export const MOBILE_CARDS_EXPANDED_STORAGE_KEY = 'cld.mobile-cards-expanded';
/** localStorage key: this viewer's three-state mobile roster presentation. */
export const MOBILE_ROSTER_STATE_STORAGE_KEY = 'cld.mobile-roster-state';
/** The phone roster can show compact cards, full cards, or only its restore handle. */
export const MOBILE_ROSTER_STATES = {
  HIDDEN: 'hidden',
  COMPACT: 'compact',
  EXPANDED: 'expanded',
} as const;
/** A full phone roster card is deliberately wide enough for its centered face and one-line chips. */
export const MOBILE_ROSTER_CARD_WIDTH_PX = 96;
/** Full phone roster cards make the orchestrator's face more prominent than the compact strip. */
export const MOBILE_ROSTER_FACE_PX = 48;
/** localStorage key: this viewer opened the character detail's full list (the big tiles otherwise). */
export const STAT_DETAIL_FULL_STORAGE_KEY = 'cld.stat-detail-full';
/** The summary popover's face, and the detail view's (CSS px). */
export const STAT_SUMMARY_FACE_PX = 48;
/** The summary popover never grows wider than this, however long the activity line (it wraps, 2 lines). */
export const STAT_SUMMARY_MAX_PX = 300;
/** The summary's fatigue bar: a fixed length, halfway between the old short bar and the stretched one. */
export const STAT_SUMMARY_BAR_PX = 100;
/** The rebirth mark's pixels (a soul flame): outer, inner and the sparkle (at 0 the mark is dimmed by opacity). */
export const REBIRTH_COLORS = { outer: '#e8742a', inner: '#ffd84a', spark: '#fff6a0' } as const;
export const STAT_DETAIL_FACE_PX = 64;
/** The open detail view looks at its character again this often (ms). */
export const STAT_REFRESH_MS = 500;
/** The level ring on the detail view's growth tile: its size and number (CSS px). */
export const STAT_TILE_RING = { ring: 34, level: 13 } as const;
/** OWNER-STATS: how often the page reports the owner's steps and shown time (the daemon's cap is 60 s). */
export const OWNER_REPORT_MS = 30_000;
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
/** The phone's walking joystick (JOYSTICK): the pad's side, a thumb-sized square. */
export const JOYSTICK_SIZE_PX = 120;
/** The knob's side. */
export const JOYSTICK_KNOB_PX = 48;
/** Drag shorter than this share of the pad's radius is no direction yet. */
export const JOYSTICK_DEAD_ZONE = 0.3;
/** Idle time before the pad fades, and how long the fade takes. */
export const JOYSTICK_FADE_DELAY_MS = 3000;
export const JOYSTICK_FADE_MS = 400;
/** The pad's opacity while in use and once faded (nearly gone, still findable). */
export const JOYSTICK_OPACITY = 0.75;
export const JOYSTICK_FADED_OPACITY = 0.15;
/** Above the lobby's mini board (BOARD_Z_INDEX), which can sit where the pad does. */
export const JOYSTICK_Z_INDEX = BOARD_Z_INDEX + 1;
/** The phone's camera buttons (an owner's way back to their character) stay tappable where the mini board sits. */
export const CAMERA_CONTROL_Z_INDEX = BOARD_Z_INDEX + 1;
/** Gap of the phone's camera group to the office's right edge (the desktop's is under the elevator). */
export const CAMERA_CONTROL_EDGE_GAP_PX = 8;
/** Gap to the office's left edge (plus the safe inset), CSS px. */
export const JOYSTICK_MARGIN_PX = 8;
/** Gap to the office's bottom edge: above the hidden roster's 44 px handle at the same left edge, plus 8. */
export const JOYSTICK_BOTTOM_PX = 52;
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
/** A Home-Screen app's short viewport counts when its gap to the screen matches the top inset within this many px. */
export const STANDALONE_VIEWPORT_TOLERANCE_PX = 3;
/** A messenger history/search request the daemon never answers is given up after this. */
export const CHAT_REQUEST_TIMEOUT_MS = 20_000;

// ── ISO-PILOT: the isometric building (cld/iso) ─────────────────
/** Half a floor diamond (iso px at zoom 1): a 16 px world tile is a 16×8 diamond, so a 16×32
 *  character stands about four tiles tall, the proportions the top-down office has. */
export const ISO_HALF_W = 8;
export const ISO_HALF_H = 4;
/** A tall back wall (iso px above its floor at the building's back corner: the owner 10-26 01:48
 *  and 11-01 02:06 asked for taller storeys), a cut-away wall and a floor slab. The wall pieces
 *  (gen-iso-objects.ts) are made this tall: regenerate them when it changes. */
export const ISO_WALL_H = 68;
export const ISO_LOW_WALL_H = 5;
export const ISO_SLAB_H = 6;
/** One storey (owner 11-04 17:51: same-size floors stacked flush): a back wall, then the slab of
 *  the floor above sits on its top. A person (~32 iso px) to a storey is about 1 : 2.3. */
export const ISO_STOREY_H = ISO_WALL_H + ISO_SLAB_H;
/** The roof's parapet over the top storey (iso px), its cap's light band, and how far in (tiles)
 *  the deck sits inside it. */
export const ISO_ROOF_H = 6;
export const ISO_ROOF_CAP_H = 2;
export const ISO_ROOF_INSET = 1;
/** A closed storey's facade: a window bay every this many iso px along a face, its mullion's
 *  width, the glass band (iso px from the floor line up: from, to; the lobby's is taller, with a
 *  transom bar at this height), and the diagonal shine on the glass (period, width). */
export const ISO_BAY_PX = 16;
export const ISO_MULLION_PX = 2;
export const ISO_GLASS_BAND = { from: 14, to: 58 } as const;
export const ISO_LOBBY_GLASS_BAND = { from: 3, to: 62, transom: 22 } as const;
export const ISO_SHINE = { period: 26, width: 3 } as const;
/** The facade's colours by day and by night: wall and slab trim on the left (shade) and right
 *  faces, the glass, its shine, a lit bay at night, the mullions, the roof deck, its inner edge
 *  and the parapet's cap, and the band of the floor in focus (the one accent). */
export const ISO_FACADE = {
  day: {
    wallL: '#d9c7a0',
    wallR: '#f0e3c5',
    trimL: '#a8693a',
    trimR: '#c8844a',
    glassL: '#4f6c9e',
    glassR: '#6a8bc0',
    shine: '#a9c4ec',
    lit: '#ffe39a',
    mull: '#efe4c8',
    roof: '#aeb0c4',
    roofIn: '#9496ae',
    cap: '#fbf6ea',
    accent: '#8b6cff',
  },
  night: {
    wallL: '#4a4768',
    wallR: '#5d5a80',
    trimL: '#3a2c3e',
    trimR: '#4a3848',
    glassL: '#1c2650',
    glassR: '#24305e',
    shine: '#33427a',
    lit: '#ffd27a',
    mull: '#6c6890',
    roof: '#2e3352',
    roofIn: '#252a46',
    cap: '#6e6a92',
    accent: '#9d87ff',
  },
} as const;
/** At night this share of a closed storey's bays is lit (a stable pick per bay). */
export const ISO_NIGHT_LIT = 0.35;
/** The floors above the one in focus are lifted off: their outline (owner 11-04 19:47: clear
 *  enough to count the floors). Each storey's slab is a faint band along its front, edged by a
 *  floor line; the floor lines, the outer corner posts and the roof's edge are a dark line with a
 *  light line along its middle, so they read on the light fog and the green ground alike. Where
 *  they cross the floor in focus they are drawn at `over` opacity (its people and furniture stay
 *  clear). Each storey's label sits by its front corner on a backing with an edge. */
export const ISO_OUTLINE = {
  day: {
    line: 'rgba(52, 44, 104, 0.92)',
    core: 'rgba(255, 255, 255, 0.9)',
    band: 'rgba(70, 62, 120, 0.2)',
    label: '#2e2860',
    back: 'rgba(255, 255, 255, 0.94)',
    edge: '#463e78',
  },
  night: {
    line: 'rgba(196, 188, 255, 0.92)',
    core: 'rgba(255, 255, 255, 0.95)',
    band: 'rgba(196, 188, 255, 0.18)',
    label: '#f2f0ff',
    back: 'rgba(22, 20, 48, 0.94)',
    edge: '#b4a8ff',
  },
} as const;
/** The line: at least this many CSS px wide (or this many iso px, whichever is wider), its light
 *  middle a third of it (at least one CSS px). */
export const ISO_OUTLINE_LINE_PX = 3;
export const ISO_OUTLINE_W = 1.5;
export const ISO_OUTLINE_OVER_ALPHA = 0.5;
/** The label: iso px of type, never under the minimum CSS px; this far (iso px) right of the
 *  storey's front corner, up on its band. */
export const ISO_OUTLINE_LABEL_PX = 9;
export const ISO_OUTLINE_LABEL_MIN_PX = 13;
export const ISO_OUTLINE_LABEL_INSET = 6;
/** The lobby board outside (owner 11-04 19:47, iso/billboard.ts): the old lobby board's own
 *  screen (BoardView, 48 x 16 em) on a billboard, level with the screen. Its outer face (iso px:
 *  the screen at 240 x 80 inside a `frame` all round, so the old board's em is 10 CSS px at the
 *  lobby's zoom 2, BOARD_MIN_EM_PX, where its pages turn), its right end this far right of the
 *  building's left corner, this far below the left face's slab line, on posts this tall set this
 *  far in. */
export const ISO_BILLBOARD = {
  w: 244,
  h: 84,
  frame: 2,
  along: 248,
  gap: 8,
  post: 10,
  postIn: 30,
} as const;
/** Its body (owner 11-04 21:04: more 3D): the case's depth (iso px, drawn up and right at the iso
 *  angle: a top and a right side), the posts' width, the shadow on the ground (iso px offset of
 *  its far edge, down and right), and the screen's glow (rings of this many device px). */
export const ISO_BILLBOARD_BODY = {
  depth: 8,
  post: 3,
  shadow: { dx: 22, dy: 11 },
  glow: 3,
} as const;
/** Its colours: the posts (lit side, shaded side, cap), the case's top and right side, the
 *  frame (the accent) with its light upper and dark lower edge, the shadow, the glow by day and
 *  by night (per ring, outermost faintest). */
export const ISO_BILLBOARD_INK = {
  post: '#6a6790',
  postShade: '#3a3858',
  postCap: '#8c88b4',
  top: '#3e3a66',
  side: '#24213f',
  frame: '#8b6cff',
  frameLight: '#b9a4ff',
  frameDark: '#5a40c8',
  shadow: 'rgba(20, 18, 44, 0.28)',
  glowDay: ['rgba(139, 108, 255, 0.10)', 'rgba(139, 108, 255, 0.18)', 'rgba(139, 108, 255, 0.28)'],
  glowNight: [
    'rgba(157, 135, 255, 0.16)',
    'rgba(157, 135, 255, 0.28)',
    'rgba(157, 135, 255, 0.42)',
  ],
} as const;
/** The art's master density: picture px per world px of the owner's pieces (a 16 px tile is a
 *  192×96 diamond), each drawn at every zoom from its one master. */
export const ISO_MASTER_DENSITY = 12;
/** The finest density the floor cache is drawn at (art.ts DENSITIES): floors and back walls
 *  ship no finer (iso/ship.ts). */
export const ISO_GROUND_MAX_DENSITY = 4;
/** Margin (iso px) around the building in the whole-building framing. */
export const ISO_FRAME_MARGIN = 12;
/** billboard2-1104: the lobby's view may cut this much (iso px) off its back walls' tops to show
 *  the whole billboard screen in front (the old board's screen at its readable size). */
export const ISO_LOBBY_WALL_CUT = 16;
/** PHONE-ZOOM: the isometric first view on a phone frames the floor's occupied rooms, never
 *  farther than this zoom: an iso character is ~16 iso px tall, so at 6 it is ~96 device px
 *  (32 CSS px at dpr 3), readable, with its name tag clear of the next one's. */
export const PHONE_ISO_ZOOM_MIN = 6;
/** ...and never closer than this (one small room), so the room around the agents still shows. */
export const PHONE_ISO_ZOOM_MAX = 8;
/** CSS px at the phone view's bottom that the floating view buttons (auto, my character, lobby)
 *  cover: the billboard's foot is kept above them. */
export const PHONE_ISO_BOTTOM_CLEAR_CSS = 64;
/** Seconds the phone view waits for the agents to arrive after the first frame (the layout comes
 *  before the characters) before it settles on the floor's rooms. */
export const PHONE_ISO_SETTLE_S = 4;
/** Half-extent (tiles) of the depth box a character stands in. */
export const ISO_CHARACTER_BOX = 0.3;
/** An isometric object covering a character it is painted after is drawn at this opacity. */
export const ISO_OCCLUSION_ALPHA = 0.45;
/** World px a seated character's feet move towards its desk. */
export const ISO_SIT_FORWARD_PX = 3;
/** World px a picture hung on a wall drops when that wall is cut away (it rests on its top). */
export const ISO_LOW_WALL_ITEM_DROP = 5;

// ── BACKGROUND: the isometric office's surroundings (cld/gfx/bg) ─────
/** The sky is day from this hour to this one by the host's clock (hours, 0-24). */
export const BG_DAY_START_HOUR = 6;
export const BG_DAY_END_HOUR = 18;
/** The ground in tiles of the building's floor grid: the main plot is the floor plate plus this
 *  many tiles of plaza and pavement on every side; a road this wide runs round each plot; every
 *  other plot is this many tiles square (its outermost tile is pavement). building-a-1104: the
 *  neighbours are at our building's scale (owner 11-04 17:51), so the blocks are big enough to
 *  hold them. */
export const BG_PAD_TILES = 4;
export const BG_ROAD_TILES = 4;
export const BG_BLOCK_TILES = 26;
/** A lamp stands on a plot's pavement at each corner and at the middle of each side (iso px:
 *  about a person and a half). */
export const BG_LAMP_HEIGHT = 36;
/** Footprint (tiles) of a tower and its height in our storeys (ISO_STOREY_H), a house's
 *  footprint and height (iso px: a storey of a home is lower than an office's), its roof. */
export const BG_TOWER_TILES = 15;
export const BG_TOWER_STOREYS = { min: 2, max: 5 } as const;
export const BG_HOUSE_TILES = 7;
export const BG_HOUSE_H = 58;
export const BG_HOUSE_ROOF_STEPS = 4;
/** A neighbour's window bays: one every this many iso px along a face (its mullion this wide, none
 *  this near the corners), and a house's one glass band (iso px from the ground: from, to). */
export const BG_BAY_PX = { every: 16, mullion: 3, inset: 3 } as const;
export const BG_HOUSE_GLASS = { from: 12, to: 40 } as const;
/** A tree's crown radius and trunk (iso px): taller than a person, as a street tree is. */
export const BG_TREE_R = 9;
export const BG_TREE_TRUNK = { w: 3, h: 14 } as const;
/** The background is painted in square pieces of this many iso px, each when first in view. */
export const BG_CHUNK = 256;
/** At most this many pieces are kept (the least recently shown go first). */
export const BG_CHUNKS_KEPT = 80;
/** A piece also paints what stands this far (iso px) beyond its edge: glows, crowns, a tower's
 *  ground below the piece its top is in (a tower is BG_TOWER_TILES wide). */
export const BG_OBJECT_REACH = { x: 140, y: 40 } as const;
/** The fog ring round the plot (building-a-1104, owner 11-04 17:51: no horizon, the edge of the
 *  world fades out like a fog of war): clear this far (iso px, a circle once the 2:1 squash is
 *  undone) beyond the building's half width, puffs on two rings round that edge (radius out from
 *  it, gap between puffs, puff radius; big ones behind), plain fog past `solid`; painted once
 *  at one picture px per `texel` iso px. Owner 11-04 21:04: wider, so a row or two of the
 *  neighbours show round the building (a coarser texel keeps the bigger picture smaller than the
 *  first one: 661 x 330 px, about 0.9 MB). */
export const BG_FOG = {
  margin: 480,
  rings: [
    { out: 34, gap: 46, r: 30 },
    { out: 6, gap: 40, r: 20 },
  ],
  jitter: 18,
  solid: 46,
  texel: 3,
  extent: 1.3,
} as const;
/** An empty glow sprite's cache holds at most this many entries. */
export const BG_SPRITE_CACHE_MAX = 32;
/** A canvas colour from an "r,g,b" triplet and an alpha (the background's glows and haze). */
export const rgbaOf = (triplet: string, alpha: number): string => `rgba(${triplet},${alpha})`;

// ── C1 (cld/director): character moments, a coffee break, a level-up and a rebirth ─────
/** Moments that may wait behind the one playing, per character. */
export const FX_QUEUE_MAX = 3;
/** Each level-up variant's length (s): A light pillar, B star orbit and nova, C fireworks. */
export const FX_LEVELUP_SEC = { levelUpA: 3, levelUpB: 3.2, levelUpC: 3.5 } as const;
/** The variants a live level-up picks from at random (owner 11-01: all three; theme packs add theirs later). */
export const FX_LEVELUP_LIVE = ['levelUpA', 'levelUpB', 'levelUpC'] as const;
/** C1-FX2: the grand rebirths' lengths (s): R1 ascension, R2 phoenix, R3 constellation. */
export const FX_REBIRTH_SEC = { rebirthR1: 6, rebirthR2: 6.2, rebirthR3: 6.5 } as const;
/** When each candidate's gathering charge bursts (s). */
export const FX_REBIRTH_BURST_SEC = { rebirthR1: 1.8, rebirthR2: 2, rebirthR3: 2.6 } as const;
/** The grand rebirths a live 환생 picks from at random (owner 11-01 11:31: all three). */
export const FX_REBIRTH_LIVE = ['rebirthR1', 'rebirthR2', 'rebirthR3'] as const;
/** The grand rebirth: how dark the screen around the character gets, the clear disc round it
 *  (world px, its edge one half-dim step wider), and the white flash at the burst (s, peak alpha). */
export const FX_DIM_ALPHA = 0.8;
export const FX_DIM_RX = 40;
export const FX_DIM_RY = 46;
export const FX_DIM_EDGE = 1.35;
export const FX_FLASH_SEC = 0.28;
export const FX_FLASH_ALPHA = 0.75;
/** Its title, bigger than the level-up's (device px per zoom, crisp steps). */
export const FX_GRAND_TITLE_PX_PER_ZOOM = 28;
export const FX_GRAND_SUB_PX_PER_ZOOM = 11;
/** INHERIT (계승): its length and beats (s): the ghost comes in, raises the flame, hands it over,
 *  the flame arrives in the heir, the title stamps in. */
export const FX_INHERIT_SEC = 5.2;
export const FX_INHERIT_BEATS = { ghost: 0.9, raise: 1.7, pass: 2.5, title: 2.9 } as const;
/** The ghost stands this far beside the heir (world px); the clear disc is this much wider. */
export const FX_INHERIT_GHOST_DX = 24;
export const FX_INHERIT_DIM_WIDEN = 1.45;
/** The ghost: its alpha, and the canvas filter that pales it into a spirit (none where unsupported). */
export const FX_INHERIT_GHOST_ALPHA = 0.55;
export const FX_INHERIT_GHOST_FILTER = 'grayscale(1) brightness(1.6) sepia(0.4) hue-rotate(115deg)';
/** The add dialog asks for a folder's removed agents this long after its folder stops changing (ms). */
export const INHERIT_ASK_MS = 300;
/** prefers-reduced-motion: the still badge shows this long (s). */
export const FX_STILL_SEC = 2.5;
/** The "+1" rest pop rises and fades in this long (s), this far (world px). */
export const FX_PLUS_SEC = 1.2;
export const FX_PLUS_RISE_PX = 10;
/** A coffee break that has not come back by then ends where it is (s). */
export const FX_COFFEE_MAX_SEC = 45;
/** COMPACT-COFFEE: a break held while its agent compacts drinks on at most this long (s). */
export const FX_COFFEE_HOLD_MAX_SEC = 300;
/** COMPACT-COFFEE: after the Compacting spinner went, the 휴식 count's rise this soon is the same
 *  compaction (its break played already); a later one is a compaction of its own (ms). */
export const COMPACT_COFFEE_DEDUPE_MS = 120_000;
/** The rebirth's big title: device px per zoom step, rounded to the pixel font's crisp step. */
export const FX_TITLE_PX_PER_ZOOM = 18;
export const FX_SUB_PX_PER_ZOOM = 9;
/** Words and bubbles keep this far (CSS px, the nameplate's height) above the nameplate's foot. */
export const FX_PLATE_CLEAR_PX = 34;
/** Text outline thickness in device px. */
export const FX_TEXT_OUTLINE_PX = 2;
export const FX_COLORS = {
  ink: '#1b1430',
  white: '#ffffff',
  gold: '#ffd84a',
  goldDeep: '#e89a1c',
  paleGold: 'rgba(255, 236, 150, 0.35)',
  core: 'rgba(255, 255, 240, 0.85)',
  cyan: '#5ef2ff',
  magenta: '#ff5ed2',
  violet: '#8a6bff',
  green: '#58d46a',
  coral: '#ff7a59',
  flash: 'rgba(255, 255, 255, 0.9)',
  bubble: '#f4f1e6',
  cup: '#ffffff',
  coffee: '#6b3b1e',
  steam: 'rgba(255, 255, 255, 0.7)',
  dim: '#05030f',
  flame: '#e8402a',
  orange: '#ff8a1c',
  starLine: '#9fd8ff',
  night: '#2a2f8a',
  /** INHERIT: the 계승's spirit flame and its links. */
  spirit: '#7ff5d8',
  spiritDeep: '#1fa889',
  spiritPale: 'rgba(127, 245, 216, 0.28)',
} as const;
/** Firework and confetti colours, in turn. */
export const FX_SPARK_COLORS = [
  '#ffd84a',
  '#ff5ed2',
  '#5ef2ff',
  '#58d46a',
  '#ff7a59',
  '#ffffff',
] as const;
/** Synth: the jingle's loudness (times the user's volume), and the coffee pop's. */
export const FX_JINGLE_VOLUME = 0.32;
export const FX_POP_VOLUME = 0.16;
/** The offline render of a jingle (dev runner): sample rate and length (s). */
export const FX_WAV_RATE = 44100;
export const FX_WAV_SEC = 7;

// ── P4 개발실 (dev room, mockups-1101/devroom-W1b, W5) ───────────────
/** A worktree card's mug shot in the rail, and on the phone's list. */
export const DEVROOM_FACE_PX = 22;
export const DEVROOM_PHONE_FACE_PX = 24;
/** DEVROOM-NAMES: a phone file tab shows this many characters of its file name before the ellipsis. */
export const FILE_TAB_CH = 16;
/** Phone: a worktree with no Task and nobody on it folds into `쉬는 작업 N개` after this many quiet days. */
export const DEVROOM_RESTING_DAYS = 3;
/** The `…` menu: its width, and the height kept clear under it before it flips up. */
export const DEVROOM_MENU_W_PX = 300;
export const DEVROOM_MENU_H_PX = 216;
/** DV2 실행 row: a running run's log is read again this often while its pane is open (as the job panel);
 *  the failed lines shown and sent to an agent; the bottom drawer's height (mockup D2). */
export const DEVROOM_RUN_LOG_MS = 3_000;
export const DEVROOM_RUN_TAIL_LINES = 12;
export const DEVROOM_RUN_DRAWER_PX = 160;
/** The gap between the `…` button and its menu. */
export const DEVROOM_MENU_GAP_PX = 4;
/** DEVROOM-FIX: the graph's left edge of a top card (rail, phone), one step in per branch level, and the deepest step drawn. */
export const DEVROOM_CARD_LEFT_PX = 40;
export const DEVROOM_PHONE_CARD_LEFT_PX = 14;
export const DEVROOM_GRAPH_STEP_PX = 18;
export const DEVROOM_PHONE_GRAPH_STEP_PX = 12;
export const DEVROOM_GRAPH_MAX_DEPTH = 3;
/** DEVROOM-SUBVIEW: the 터미널 board. A card's width in the status strip; a tool result's lines before
 *  `더 보기`; the finished sub-agents remembered; the clock of the elapsed times. */
export const DEVROOM_CARD_W_PX = 230;
export const DEVROOM_RESULT_LINES = 4;
/** DEVROOM-SUBCHAT: the most output chips (commits, files) shown under a sub-agent's words. */
export const DEVROOM_OUTPUT_CHIPS_MAX = 6;
/** DEVROOM-SUBCHAT: a commit chip's message, cut to this many characters. */
export const DEVROOM_COMMIT_CHIP_CHARS = 40;
export const DEVROOM_SUBS_DONE_MAX = 20;
/** DEVROOM-SIDEBAR: distinct paths kept per sub-agent to place it in a worktree, and sub-agents traced per visit. */
export const DEVROOM_TRACE_PATHS_MAX = 64;
export const DEVROOM_TRACES_MAX = 200;
/** DEVROOM-SIDEBAR (owner 11-06 22:11: projects and worktrees must read apart): each tree level's step,
 *  project head → its worktrees, a worktree → its agent rows. */
export const DEVROOM_TREE_STEP_PX = 12;
export const DEVROOM_SIDE_INDENT_PX = 16;
export const DEVROOM_BOARD_TICK_MS = 15_000;
/** DEVROOM-BOARD2 (Orca's Done/Idle): after its turn an agent is 끝남 until its last news is this old, then 쉬는 중. */
export const DEVROOM_DONE_MS = 30 * 60_000;
/** Under this, a 끝남 / 쉬는 중 agent's last news reads 방금 (elapsedDuration's 방금 시작 is for work). */
export const DEVROOM_JUST_NOW_MS = 60_000;
/** The free panes (Orca-style): a drop this close to a pane's edge (share of its size) splits it;
 *  a divider never makes a pane narrower or shorter than this. */
export const DEVROOM_DROP_EDGE = 0.25;
export const DEVROOM_PANE_MIN_PX = 220;

// ── DV3 개발실 명령 팔레트 (Ctrl+K, mockup D3) ──
/** The most lines one group of the palette lists (the rest is a few more letters away). */
export const DEVROOM_PALETTE_GROUP_MAX = 8;
/** Above the windows, the dock and the dialogs it opens from (BOARD_FULL_Z_INDEX), under the attachment viewer. */
export const DEVROOM_PALETTE_Z = 75;
/** Frames a jump waits for the 개발실 to draw the pane it goes to, before it gives up focusing it. */
export const DEVROOM_PALETTE_FOCUS_FRAMES = 30;

// ── P4 개발실 병합 tab (mockups-1101/devroom-W2, W3, mockups-1028/orca-tools-K) ──
/** How long a write's answer is awaited before the step is called lost. */
export const MERGE_ACT_TIMEOUT_MS = 60_000;
/** Lines of the file shown around a conflict block. */
export const MERGE_CONTEXT_LINES = 2;
/** K's card, W2's file column, W3's table columns (checkbox, status, merged, changed, size). */
export const MERGE_CARD_W_PX = 440;
export const MERGE_FILES_W_PX = 210;
export const MERGE_TABLE_COLS = '44px minmax(0,1fr) 120px 150px 140px 100px';
/** W3's checkbox. */
export const MERGE_CHECK_PX = 20;
/** The size text's steps. */
export const MERGE_KIB = 1024;
export const MERGE_SIZE_DECIMALS = 1;
// ── P4 검토 (review-loop R2/R4) ──────────────────────────────────────
/** DEVROOM-PERF: the open review's changed-file list is asked again this often while it is on screen (ms). */
export const DEVROOM_CHANGES_POLL_MS = 1_000;
/** T-73: how long the 검토 대기 notice waits for the daemon's repository answer before it opens the issue board. */
export const REVIEW_TOAST_WAIT_MS = 3_000;

// ── Explorer editor (P4 S5) ──────────────────────────────────
/** While a file is open for editing, its disk hash is read this often (only while the page is visible). */
export const EDIT_POLL_MS = 5_000;

// ── Text zoom (editor, preview, dev room diff) ───────────────
/** The −/+ buttons and Ctrl+wheel move along these scales; the first is the floor, the last the ceiling. */
export const TEXT_ZOOM_STEPS: readonly number[] = [
  0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3,
];
export const TEXT_ZOOM_DEFAULT = 1;
/** One mouse-wheel notch (100) moves a step; a trackpad pinch's fine deltas are summed to this much first. */
export const TEXT_ZOOM_WHEEL_NOTCH = 100;
/** Key in the browser's localStorage per surface: `${prefix}${surface}`. */
export const TEXT_ZOOM_STORAGE_PREFIX = 'cld.textzoom.';
/** An image preview fits the pane's width and this much of the screen's height (vh) at 100%. */
export const IMAGE_FIT_MAX_VH = 70;

// ── Explorer 최근 산출물 ─────────────────────────────────────
/** A long list shows this many of the newest first, 더 보기 adds as many again. */
export const RECENT_OUTPUTS_SHOWN = 8;
export const RECENT_FOLD_STORAGE_KEY = 'cld.recentFolded';

// ── SPT-P1A 개요 / 문서 tabs (cld/spec/) ─────────────────────
/** The 개요's lists (진행·검토·막힘, recent jobs, recent commits) show this many each. */
export const SPEC_LIST_SHOWN = 5;
/** RQ2: the 요구사항 tree reads this many requirements at most (the daemon's SPEC_ITEMS_PAGE_MAX); more says so and asks for a search. */
export const SPEC_REQS_TREE_MAX = 500;
/** RQ3: the new issue's title from the requirement, its first characters (RQW §2.5); the daemon takes up to SPEC_ISSUE_TITLE_MAX. */
export const SPEC_ISSUE_TITLE_SHOWN = 60;
export const SPEC_ISSUE_TITLE_MAX = 200;
/** RQ2: the issues the '왜' box names one by one; the rest are one count. */
export const SPEC_WHY_ISSUES = 2;
/** The modal layer of the 켜기 window (above the 현황판 window). */
export const SPEC_DIALOG_Z = 64;
/** SPT-P1B: the 요구사항 search waits this long after the last key before it asks again. */
export const SPEC_SEARCH_WAIT_MS = 250;
/** SPT-P3-ACCEPT: an acceptance memo at most (the daemon's SPEC_LINK_NOTE_MAX). */
export const SPEC_ACCEPT_NOTE_MAX = 500;
/** SPT-P3-ISSUES: rows the 이슈 tab's requirement picker asks `…/items` for. */
export const SPEC_ISSUES_PICK_MAX = 20;
/** The deepest heading level a document's 제목도 항목 mode may take (the daemon's SPEC_HEADING_DEPTH_MAX). */
export const SPEC_DEPTH_MAX = 6;
/** 같은 항목 확인's word diff gives up past this many word pairs (two 4 KB texts are about 600 x 600). */
export const SPEC_DIFF_CELLS_MAX = 400_000;
/** SPT-P3-OVERVIEW: 끝 (지난 7일 +N)'s window; 최근 본 요구사항 keeps this many; a burst of specChanged refetches the 개요 once, this long after the last. */
export const SPEC_OVERVIEW_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SPEC_OVERVIEW_VIEWED = 5;
export const SPEC_OVERVIEW_REFETCH_MS = 500;
/** BRN K5: the 개요's five lines show this many board Tasks for 어디까지 (latest done) and 다음 (top of 할 일). */
export const RESUME_BOARD_SHOWN = 3;

// ── SPT-P3-GRAPH 그래프 tab and requirement detail (cld/spec/TraceGraph.tsx, ReqDetail.tsx) ──
/** Node boxes the dagre layout reserves (px, the pixel node components draw inside them). */
export const SPEC_GRAPH_NODE = {
  req: { w: 184, h: 56 },
  group: { w: 184, h: 60 },
  commit: { w: 128, h: 32 },
  other: { w: 152, h: 40 },
} as const;
/** dagre spacing: between ranks (left to right), between nodes of one rank, around the drawing. */
export const SPEC_GRAPH_RANK_GAP = 64;
export const SPEC_GRAPH_NODE_GAP = 20;
export const SPEC_GRAPH_MARGIN = 12;
/** A cluster box: padding around its members and the band its name sits in. */
export const SPEC_GRAPH_BOX_PAD = 12;
export const SPEC_GRAPH_BOX_HEAD = 22;
/** More commits than this on one Task or requirement fold into one '커밋 +N' node (SPT §7.1). */
export const SPEC_GRAPH_FOLD_MIN = 1;
/** The minimap's size (px): small, so it covers little of the drawing in its corner. */
export const SPEC_GRAPH_MINIMAP = { width: 120, height: 80 } as const;
/** Zoom range of the graph (wheel, pinch, buttons). */
export const SPEC_GRAPH_ZOOM = { min: 0.2, max: 2.5 } as const;
/** SPT-P4A 아키텍처 view: a group's parent chain is walked at most this deep (a cycle or a runaway chain ends there). */
export const SPEC_ARCH_DEPTH_MAX = 32;
// ── SPT C1 지도 tab (cld/spec/CockpitMap.tsx; SPT §8.3) ──
/** Imports between two cells drawn as an arrow (the server's SPEC_MAP_ARROW_MIN, R4's value). */
export const SPEC_MAP_ARROW_MIN = 50;
/** A band with this many cells or more says its pairs inside the cells (⇄ text) instead of lines. */
export const SPEC_MAP_TEXT_PAIRS_FROM = 4;
/** An arrow's head (px). */
export const SPEC_MAP_ARROW_HEAD = 6;
/** SPT C2: segments of a bar (근거 막대, a cell's 7-day activity), feature chips on a cell, list rows before '+N ▼'. */
export const SPEC_MAP_BAR_SEGMENTS = 10;
export const SPEC_MAP_CHIPS = 2;
export const SPEC_MAP_LIST_SHOW = 7;
/** 아키텍처 그래프 (cld/spec/ArchCards.tsx): a card's size and the grid's gaps in flow px, desktop and phone. */
export const SPEC_CARD = { w: 264, h: 156, gapX: 64, gapY: 56, cols: 3 } as const;
export const SPEC_CARD_PHONE = { w: 120, h: 92, gapX: 20, gapY: 28, cols: 3 } as const;
/** A card's inside parts and requirement areas named on it; recent changes in the detail (phone: fewer). */
export const SPEC_CARD_INSIDE = 3;
export const SPEC_CARD_REQS = 3;
export const SPEC_CARD_RECENT = 3;
export const SPEC_CARD_RECENT_PHONE = 2;
/** The lines' arrow heads (React Flow markers take a colour, not a CSS variable): plain, two-way, the picked card's. */
export const SPEC_CARD_LINE = { plain: '#8a8aa6', two: '#e8b41c', on: '#a98fff' } as const;
/** fitView's padding (a share of the pane). */
export const SPEC_CARD_FIT_PAD = 0.08;
/** Icon sizes (px): on a card, on a phone card, in a tree row or a button. The pane's dot grid (gap, dot). */
export const SPEC_CARD_ICON = { card: 24, phone: 20, small: 12 } as const;
export const SPEC_CARD_DOTS = { gap: 16, size: 2 } as const;
/** BRN K8: design modules listed in a picked card's note (the rest is a count). */
export const SPEC_DESIGN_NOTE_MODULES = 5;

// ── GAME-UI-0 game parts (cld/game/parts.tsx; specs/ui-mock-1103 cockpit D2) ──
/** An 8x8 pixel icon drawn at 2x. */
export const GAME_ICON_PX = 16;
/** SegBar's segments (the mock's 작업 연결 bar). */
export const GAME_SEGBAR_SEGMENTS = 24;
/** 이번 주 수락: a day's column holds this many cells at most (the number under it is the count); the past-weeks bars are this tall. */
export const GAME_WEEK_CELLS = 10;
export const GAME_WEEK_BAR_PX = 36;
/** FEAT-QUESTS-GPT-LOOK: the board's width (px) from which the status groups are columns, and from which a card's detail opens in a side panel. */
export const QUEST_COLS_MIN_PX = 860;
export const QUEST_SIDE_MIN_PX = 1180;

// ── GAME-UI-1 G3: party roster, job run, game HUD (cld/game; specs/ui-mock-1103/ideas/agents 05-07) ──
/** 컨텍스트 남음 at or under this is amber (05). */
export const GAME_CONTEXT_WARN_PCT = 20;
/** The card bar's small context bar. */
export const GAME_MINI_SEGMENTS = 8;
/** The job runner: world px x this, and its walk (8 fps), only while the card is on screen. */
export const GAME_RUN_FIGURE_ZOOM = 2;
export const GAME_RUN_WALK_MS = 125;
/** The job track's cells. */
export const GAME_RUN_SEGMENTS = 30;
/** A usage window with this much left or less is amber, 0 left is dimmed (07). */
export const GAME_USAGE_WARN_LEFT = 10;
/** FEAT-HUD-CONTROL-CENTER: a usage window's bar (HP cells in 픽셀 감성, one smooth bar in 모던). */
export const CC_BAR_SEGMENTS = 10;
/** The folded tile's usage: the agents closest to their limits it shows (the rest are "외 N"). */
export const CC_FOLDED_AGENTS = 2;
/** A usage report older than this shows its age ("12분 전 기준"): the status line reports on each Claude reply. */
export const USAGE_REPORT_FRESH_MS = 5 * 60_000;
/** A longer window (the week) with this little left still beats a plan's 5-hour window on the folded tile. */
export const USAGE_URGENT_LEFT_PCT = 10;
/** AGENT-UPDATE: a successful 업데이트 result stays this long (a failed one stays until the panel closes). */
export const AGENT_UPDATE_RESULT_MS = 60_000;
/** AGENT-LATEST: the usage panel's ↻ asks the daemon for the newest CLI versions at most this often (the daemon throttles the same). */
export const AGENT_LATEST_ASK_GAP_MS = 30_000;
/** The open control center's latest news rows (모두 보기 opens the notification panel). */
export const CC_NEWS_ROWS = 3;
/** An agent logo's brand colour (Simple Icons 16.36.0's hex, cld/icons/agentLogos.ts); black or white marks have none. */
export const AGENT_LOGO_COLOR = { claude: '#D97757', gemini: '#8E75B2' } as const;
/** An agent without a logo: its initial on a hue made from its id (0..359, controlCenter.css --mark-hue). */
export const AGENT_MARK_HUES = 360;
/** HUD heat gauge: 10 cells from 30 °C, one per 7 °C (the mock's scale; tones from format.tempTone). */
export const GAME_HEAT_SEGMENTS = 10;
export const GAME_HEAT_BASE_C = 30;
export const GAME_HEAT_STEP_C = 7;
/** The game clock: the sun from this hour, the moon from this one (host time). */
export const GAME_DAY_FROM_H = 6;
export const GAME_NIGHT_FROM_H = 18;

/**
 * 11-04: the interior (layout editor, the elevator's 편집 and 인테리어) and the looks window's 사람 꾸미기
 * and 커스텀 tabs are postponed: their ways in are hidden while these are false, the code stays.
 * The looks window itself (마스코트, 사람) is open. See cld/features.ts.
 */
export const FEATURE_INTERIOR = false;
export const FEATURE_LOOKS_CUSTOM = false;

// ── A5 현황판 (GPT mockup look, panels/Dashboard.tsx) ──
/** Tasks in progress shown before 더 보기. */
export const BOARD_LOOK_TASK_ROWS = 6;
/** Feed events in 최근 활동. */
export const BOARD_LOOK_ACTIVITY_ROWS = 6;
/** A face in a row (a mug shot's side). */
export const BOARD_LOOK_FACE_PX = 24;
/** Cells of a 시스템 요약 bar. */
export const BOARD_LOOK_METER_SEGMENTS = 10;
/** A load from this share reads warn, then bad. */
export const BOARD_LOOK_WARN_FRAC = 0.7;
export const BOARD_LOOK_BAD_FRAC = 0.9;

// ── Messenger overall search (ChatSearchAll) ───────────────
/** The list's find field searches the conversations' text from this many characters on, */
export const MESSENGER_SEARCH_ALL_MIN_CHARS = 2;
/** once typing has paused this long (the daemon reads transcripts for each request). */
export const MESSENGER_SEARCH_ALL_DEBOUNCE_MS = 400;
/** An MCP tool row names its key input (an issue title, a recipient) up to this many characters. */
export const TOOL_ROW_INPUT_MAX = 40;
/** Consecutive rows of one tool fold into one row from this many on. */
export const TOOL_RUN_MIN = 2;

// ── T-74: error reports to the daemon (cld/errorReport.ts) ──
/** Reports one page sends per window at most (a render loop would otherwise flood the socket). */
export const ERROR_REPORT_BURST = 10;
export const ERROR_REPORT_WINDOW_MS = 60_000;
