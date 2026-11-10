import { useEffect, useState } from 'react';

import { t, type TranslationKey } from '../i18n/index.js';
import { isDaytime } from './game/gameState.js';
import { PixelIcon } from './game/parts.js';
import { hostTime } from './officeHours.js';
import { useAgtyStore } from './officeStore.js';
import { useUiTheme } from './uiTheme.js';

/** Stands in for the weekday while the date line is split around it. */
const WEEKDAY_MARK = '\u0001';
const HANGUL = /[\u3131-\uD79D]/;

/** Milliseconds to the next minute change. */
const toNextMinute = (now: number): number => 60_000 - (now % 60_000);

/** The phone top bar's clock: "10.24 (금) 22:28" in the HOST's time (the one office hours use), ticking once a minute.
 *  The bars centre it (owner 10-24) and pass the Tailwind text size their height allows. `game` (GAME-UI-1,
 *  ideas/agents 07): the sun or the moon beside it and the day's 24 cells under it, this hour's lit. */
export function HostClock({
  size = 'text-2xl',
  game = false,
  part = 'full',
}: {
  size?: string;
  game?: boolean;
  /** The control center's pieces: the weekday and time (folded), the time or the date alone (its 시간 tile). */
  part?: 'full' | 'short' | 'time' | 'date';
}) {
  const readable = useUiTheme() === 'modern';
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, toNextMinute(Date.now()));
    };
    timer = setTimeout(tick, toNextMinute(Date.now()));
    return () => clearTimeout(timer);
  }, []);
  const offset = useAgtyStore().hostInfo?.utcOffsetMin ?? -new Date().getTimezoneOffset();
  const { day, minute } = hostTime(now, offset);
  const date = new Date(now + offset * 60_000);
  const weekday = t(`clock.day${day}` as TranslationKey);
  const [before, after] = t('clock.date', {
    month: t(`clock.month${date.getUTCMonth()}` as TranslationKey),
    day: date.getUTCDate(),
    weekday: WEEKDAY_MARK,
  }).split(WEEKDAY_MARK);
  const hour = Math.floor(minute / 60);
  const time = `${String(hour).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const clock = (
    <span
      className={`shrink-0 whitespace-nowrap leading-none text-text ${size}`}
      data-testid="host-clock"
      title={t('clock.title')}
    >
      {part === 'short' ? (
        `${weekday} ${time}`
      ) : part === 'time' ? (
        time
      ) : (
        <>
          {/* A narrow phone keeps only the time. */}
          <span className="max-[359px]:hidden">
            {before}
            {/* The pixel font's digits are about half the height of a Hangul syllable (Galmuri, 1.4x
                the Latin cap height): the weekday is drawn smaller so the clock reads evenly. 읽기 쉬움
                draws the digits in Galmuri too (UI-FONT), so the weekday keeps the clock's size. */}
            <span className={HANGUL.test(weekday) && !readable ? 'text-[0.7em]' : undefined}>{weekday}</span>
            {after}
            {part === 'full' && ' '}
          </span>
          {part === 'full' && time}
        </>
      )}
    </span>
  );
  if (!game) return clock;
  return (
    <span className="game-clock" data-hour={hour}>
      <span className="game-clock-t">
        <PixelIcon name={isDaytime(hour) ? 'sun' : 'moon'} />
        {clock}
      </span>
      <span className="game-day" aria-hidden="true">
        {Array.from({ length: 24 }, (_, h) => (
          <i key={h} data-at={h === hour ? 'now' : h < hour ? 'past' : undefined} />
        ))}
      </span>
    </span>
  );
}
