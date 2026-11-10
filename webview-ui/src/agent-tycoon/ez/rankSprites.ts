/**
 * RANK-LEVELS: the rank icons, drawn in code: one base sprite per style (사원증 on its
 * lanyard, 넥타이, 메달), coloured by rank along RANK_COLORS, plus a small star from
 * 이사 up (THEME.ranks `star`). 인턴 in the tie style has only the lanyard.
 * Keys: a main, d dark, w card, g card line, x star.
 */
import {
  RANK_COLORS,
  RANK_ICON_CARD,
  RANK_ICON_CARD_LINE,
  RANK_ICON_STAR,
} from '../../constants.js';
import type { SpriteData } from '../../office/types.js';
import { rankHasStar, type RankId, rankIndex, type RankStyle } from '../rank.js';

const LANYARD = ['a.....a', '.a...a.', '..a.a..', '...a...'];
const STAR = ['.wwxww.', '.wxxxw.', '.wwxww.'];
const FACE = ['.wwwww.', '.wgggw.', '.wwwww.'];

const TEMPLATES: Record<RankStyle, { plain: string[]; star: string[] }> = {
  badge: {
    plain: [...LANYARD, '.ddddd.', '.aaaaa.', ...FACE, '.ddddd.'],
    star: [...LANYARD, '.ddddd.', '.aaaaa.', ...STAR, '.ddddd.'],
  },
  tie: {
    plain: ['..ddd..', '..aaa..', '...a...', '..aaa..', '..aaa..', '.aaaad.', '.aaaad.', '.aaaad.', '..aad..', '...a...'],
    star: ['..ddd..', '..aaa..', '...a...', '..aaa..', '..aaa..', '.aaxad.', '.axxxd.', '.aaxad.', '..aad..', '...a...'],
  },
  medal: {
    plain: ['a.....d', '.a...d.', '..a.d..', '...a...', '..ddd..', '.dwaad.', '.daaad.', '.daaad.', '..ddd..'],
    star: ['a.....d', '.a...d.', '..a.d..', '...a...', '..ddd..', '.daxad.', '.dxxxd.', '.daxad.', '..ddd..'],
  },
};

/** The tie of an intern: the lanyard it has been given, nothing on it yet. */
const INTERN_TIE = [...LANYARD, '...d...'];

const cache = new Map<string, SpriteData>();

export function rankSprite(style: RankStyle, id: RankId): SpriteData {
  const key = `${style}:${id}`;
  let sprite = cache.get(key);
  if (!sprite) {
    const i = rankIndex(id);
    const { main, dark } = RANK_COLORS[Math.min(i, RANK_COLORS.length - 1)];
    const colors: Record<string, string> = {
      a: main,
      d: dark,
      w: RANK_ICON_CARD,
      g: RANK_ICON_CARD_LINE,
      x: RANK_ICON_STAR,
    };
    const rows = style === 'tie' && i === 0 ? INTERN_TIE : TEMPLATES[style][rankHasStar(id) ? 'star' : 'plain'];
    sprite = rows.map((row) => [...row].map((c) => (c === '.' ? '' : colors[c])));
    cache.set(key, sprite);
  }
  return sprite;
}
