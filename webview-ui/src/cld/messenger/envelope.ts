/**
 * GAME-UI-1 G1 (ideas/messenger 04): sending flies a 12x9 pixel envelope (3x) from 보내기 to the lead's row
 * in the chat list (its tab when the row is scrolled away or the list is not on screen): 8 whole-pixel
 * frames on an arc, 60 ms each, two trailing dots, one squashed frame on landing, the face's frame lit for
 * a frame. One flight at a time (a quick second send flies none); nothing at all without game motion.
 * The ✓ 전달됨 badge is the row's own (the real delivery state), not this flight's.
 * Plain DOM on document.body: it lives 0.75 s and is gone (no React state, no polling).
 */
import {
  MSG_ENVELOPE_FRAME_MS,
  MSG_ENVELOPE_FRAMES,
  MSG_ENVELOPE_LIT_MS,
  MSG_ENVELOPE_SCALE as SCALE,
  MSG_ENVELOPE_SQUASH_MS,
  MSG_ENVELOPE_TRAIL as TRAIL,
  MSG_ENVELOPE_TRAIL_PX as TRAIL_PX,
} from '../../constants.js';
import { gameMotion } from '../game/gameMotion.js';
import { arcPoint } from './gameMessenger.js';

// o = outline, p = paper, f = flap line, s = seal (the mock's sprite).
const ENV = ['oooooooooooo', 'ofppppppppfo', 'opfppppppfpo', 'oppfppppfppo', 'opppfssfpppo', 'oppppssppppo', 'oppppppppppo', 'oppppppppppo', 'oooooooooooo'];
const SQUASH = [ENV[0], ENV[1], ENV[3], ENV[4], ENV[6], ENV[7], ENV[8]];
const FILL = { o: 'var(--mail-line)', p: 'var(--mail-paper)', f: 'var(--mail-flap)', s: 'var(--color-accent-bright)' } as const;
const SVG = 'http://www.w3.org/2000/svg';

function sprite(rows: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  const w = rows[0].length;
  svg.setAttribute('viewBox', `0 0 ${w} ${rows.length}`);
  svg.setAttribute('width', String(w * SCALE));
  svg.setAttribute('height', String(rows.length * SCALE));
  svg.setAttribute('shape-rendering', 'crispEdges');
  rows.forEach((line, y) =>
    [...line].forEach((c, x) => {
      const r = document.createElementNS(SVG, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String(y));
      r.setAttribute('width', '1');
      r.setAttribute('height', '1');
      r.setAttribute('fill', FILL[c as keyof typeof FILL]);
      svg.append(r);
    }),
  );
  return svg;
}

/** The lead's row face if it is in view in its list, else its tab, else nothing. */
function target(agentId: number): Element | null {
  for (const el of document.querySelectorAll(`[data-mail-target="${agentId}"]`)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const box = el.closest('[data-mail-scroll]')?.getBoundingClientRect();
    if (box && (r.top < box.top || r.bottom > box.bottom)) continue;
    return el;
  }
  return null;
}

const center = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

let flying = false;

/** Fly one envelope from `from` (the send button) to the lead's row; a no-op while one flies or without motion. */
export function flyEnvelope(agentId: number, from: Element | null | undefined): void {
  if (flying || !from || !gameMotion()) return;
  const to = target(agentId);
  if (!to) return;
  flying = true;
  const a = center(from);
  const b = center(to);
  const env = document.createElement('div');
  env.className = 'mail-env';
  env.dataset.testid = 'mail-envelope';
  const open = sprite(ENV);
  env.append(open);
  const dots = TRAIL.map(() => {
    const d = document.createElement('i');
    d.className = 'mail-trail';
    return d;
  });
  document.body.append(env, ...dots);
  const half = { x: (ENV[0].length * SCALE) / 2, y: (ENV.length * SCALE) / 2 };
  const place = (t: number) => {
    const p = arcPoint(a, b, t);
    env.style.left = `${p.x - half.x}px`;
    env.style.top = `${p.y - half.y}px`;
    dots.forEach((d, i) => {
      const q = arcPoint(a, b, Math.max(0, t - TRAIL[i]));
      d.style.left = `${q.x - TRAIL_PX / 2}px`;
      d.style.top = `${q.y - TRAIL_PX / 2}px`;
      d.style.visibility = t > 0 && t < 1 ? 'visible' : 'hidden';
    });
  };
  let frame = 0;
  const step = () => {
    place(frame / MSG_ENVELOPE_FRAMES);
    if (frame++ < MSG_ENVELOPE_FRAMES) {
      window.setTimeout(step, MSG_ENVELOPE_FRAME_MS);
      return;
    }
    // Land: one squashed frame, then into the row (its face's frame lit for a frame).
    dots.forEach((d) => d.remove());
    open.replaceWith(sprite(SQUASH));
    env.style.top = `${parseInt(env.style.top, 10) + (ENV.length - SQUASH.length) * SCALE}px`;
    window.setTimeout(() => {
      env.remove();
      to.classList.add('mail-got');
      window.setTimeout(() => {
        to.classList.remove('mail-got');
        flying = false;
      }, MSG_ENVELOPE_LIT_MS);
    }, MSG_ENVELOPE_SQUASH_MS);
  };
  step();
}
