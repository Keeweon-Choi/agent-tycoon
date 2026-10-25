import { useEffect, useState } from 'react';

import { t, type TranslationKey } from '../i18n/index.js';
import { hostTime } from './officeHours.js';
import { useCldStore } from './officeStore.js';

/** Stands in for the weekday while the date line is split around it. */
const WEEKDAY_MARK = '\u0001';
const HANGUL = /[\u3131-\uD79D]/;

/** Milliseconds to the next minute change. */
const toNextMinute = (now: number): number => 60_000 - (now % 60_000);

/** The top bar's clock: "10.24 (금) 22:28" in the HOST's time (the one office hours use), ticking once a minute.
 *  The bars centre it (owner 10-24) and pass the Tailwind text size their height allows. */
export function HostClock({ size = 'text-2xl' }: { size?: string }) {
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
  const offset = useCldStore().hostInfo?.utcOffsetMin ?? -new Date().getTimezoneOffset();
  const { day, minute } = hostTime(now, offset);
  const date = new Date(now + offset * 60_000);
  const weekday = t(`clock.day${day}` as TranslationKey);
  const [before, after] = t('clock.date', {
    month: t(`clock.month${date.getUTCMonth()}` as TranslationKey),
    day: date.getUTCDate(),
    weekday: WEEKDAY_MARK,
  }).split(WEEKDAY_MARK);
  const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  return (
    <span
      className={`shrink-0 whitespace-nowrap leading-none text-text ${size}`}
      data-testid="host-clock"
      title={t('clock.title')}
    >
      {/* A narrow phone keeps only the time. */}
      <span className="max-[359px]:hidden">
        {before}
        {/* The pixel font's digits are about half the height of a Hangul syllable (Galmuri, 1.4x
            the Latin cap height): the weekday is drawn smaller so the clock reads evenly. */}
        <span className={HANGUL.test(weekday) ? 'text-[0.7em]' : undefined}>{weekday}</span>
        {after}{' '}
      </span>
      {time}
    </span>
  );
}
