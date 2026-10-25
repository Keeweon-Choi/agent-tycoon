import { encode } from 'uqr';

import { t } from '../../i18n/index.js';

/** A QR code as one SVG path (uqr, pinned): dark modules on a white quiet zone. */
export function QrCode({ text, size = 200 }: { text: string; size?: number }) {
  const { data } = encode(text, { ecc: 'M', border: 2 });
  const n = data.length;
  let path = '';
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <svg
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="bg-white text-black block"
      role="img"
      aria-label={t('auth.loginQr')}
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
