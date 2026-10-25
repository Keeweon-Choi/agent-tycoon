/** The tree's pixel chevron: ▶ closed, ▼ open, in the text colour. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 7 7"
      className={`w-14 h-14 shrink-0 ${open ? 'rotate-90' : ''}`}
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden
    >
      <path d="M2 0h1v7H2zM3 1h1v5H3zM4 2h1v3H4zM5 3h1v1H5z" />
    </svg>
  );
}
