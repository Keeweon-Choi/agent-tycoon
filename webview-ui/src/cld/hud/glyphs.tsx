/**
 * T-0077: the four HUD glyphs, hand-drawn on a 16 x 16 grid (whole-pixel
 * rectangles only, so crispEdges keeps every edge on the grid at any
 * multiple). One family; currentColor so the button's state tints them.
 */
import type { ReactNode } from 'react';

const GRID = 16;

function Glyph({ children, px = 2 }: { children: ReactNode; px?: number }) {
  return (
    <svg
      width={GRID * px}
      height={GRID * px}
      viewBox={`0 0 ${GRID} ${GRID}`}
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** 현황판: a board with three bars, on its stand. */
export const BoardGlyph = () => (
  <Glyph>
    <path fillRule="evenodd" d="M2 2h12v10H2z M3 3v8h10V3z" />
    <path d="M5 7h2v3H5z M8 5h2v5H8z M11 4h2v6h-2z M7 12h2v1H7z M4 13h8v1H4z" />
  </Glyph>
);

/** 메신저: a speech bubble with three dots. */
export const BubbleGlyph = () => (
  <Glyph>
    <path fillRule="evenodd" d="M2 2h12v9H2z M3 3v7h10V3z" />
    <path d="M5 6h1v2H5z M8 6h1v2H8z M11 6h1v2h-1z M4 11h3v1H4z M4 12h2v1H4z M4 13h1v1H4z" />
  </Glyph>
);

/** 알림: a bell. */
export const BellGlyph = () => (
  <Glyph>
    <path d="M7 1h2v1H7z M6 2h4v1H6z M5 3h6v3H5z M4 6h8v2H4z M3 8h10v2H3z M2 10h12v1H2z M6 12h4v1H6z M7 13h2v1H7z" />
  </Glyph>
);

/** 파일: a folder with its tab. */
export const FolderGlyph = () => (
  <Glyph>
    <path fillRule="evenodd" d="M1 4h14v9H1z M2 7v5h12V7z" />
    <path d="M1 3h6v1H1z M2 2h4v1H2z" />
  </Glyph>
);

/** 사무실 (the phone's Dock): a house, the office itself. */
export const HomeGlyph = () => (
  <Glyph>
    <path d="M7 1h2v1H7z M6 2h4v1H6z M5 3h6v1H5z M4 4h8v1H4z M3 5h10v1H3z M2 6h12v1H2z" />
    <path fillRule="evenodd" d="M3 7h10v7H3z M7 10v4h2v-4z" />
  </Glyph>
);

/** 터미널: a prompt window, `>_`. */
export const TerminalGlyph = ({ px = 2 }: { px?: number }) => (
  <Glyph px={px}>
    <path fillRule="evenodd" d="M1 3h14v10H1z M2 4v8h12V4z" />
    <path d="M4 6h1v1H4z M5 7h1v1H5z M6 8h1v1H6z M5 9h1v1H5z M4 10h1v1H4z M8 10h4v1H8z" />
  </Glyph>
);

/** 작업실: a toolbox with its handle. */
export const WorkbenchGlyph = () => (
  <Glyph>
    <path d="M6 2h4v1H6z M5 3h1v2H5z M10 3h1v2h-1z" />
    <path fillRule="evenodd" d="M1 5h14v9H1z M2 6v3h12V6z M2 10v3h12v-3z" />
    <path d="M7 8h2v3H7z" />
  </Glyph>
);

/** 지금 확인: a circular arrow, drawn at 1 px per grid cell to sit in a line of text. */
export const RefreshGlyph = () => (
  <Glyph px={1}>
    <path d="M10 1h1v6h-1z M11 2h1v4h-1z M12 3h1v2h-1z M5 3h5v2H5z M3 5h2v2H3z M2 7h2v3H2z M3 10h2v2H3z M5 12h6v2H5z M11 10h2v2h-2z M12 7h2v3h-2z" />
  </Glyph>
);

/** Window controls, on the same 16 grid at 1 px per cell (UI-AUDIT-DESKTOP): one glyph size in every icon button. */
const WindowGlyph = ({ d }: { d: string }) => (
  <Glyph px={1}>
    <path fillRule="evenodd" d={d} />
  </Glyph>
);
/** 최소화: a bar on the bottom line. */
export const MinimizeGlyph = () => <WindowGlyph d="M3 11h10v2H3z" />;
/** 최대화: a framed square. */
export const MaximizeGlyph = () => <WindowGlyph d="M3 3h10v10H3z M5 5v6h6V5z" />;
/** 원래 크기: two overlapping frames. */
export const RestoreGlyph = () => <WindowGlyph d="M6 2h8v8h-2V4H6z M2 6h8v8H2z M4 8v4h4V8z" />;
/** 닫기: a cross of 2 px steps. */
export const CloseGlyph = () => (
  <WindowGlyph d="M3 3h2v2H3z M5 5h2v2H5z M7 7h2v2H7z M9 9h2v2H9z M11 11h2v2h-2z M11 3h2v2h-2z M9 5h2v2H9z M5 9h2v2H5z M3 11h2v2H3z" />
);
