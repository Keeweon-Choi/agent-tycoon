/**
 * OPTIONS-3A (owner 11-04, "게임 옵션 화면"): the one row of 설정. One line, one height: the name on
 * the left, the control on the right, and every row's control ends on the same edge (the row never
 * sets its own width or padding: the tab panel does). The help is not in the row: hovering the row,
 * or picking it (focus, a tap, the arrow keys), shows it on the window's one hint line at the bottom.
 * A choice is `Choice` (켬/끔 too, as `OnOff`), so every row looks the same. `note` (an error, a
 * row's details) goes under the row.
 */
import { type ReactNode, useContext, useId } from 'react';

import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import { SettingHintContext } from './settingHint.js';

/** One height for every row (a 28 button plus 3 above and under); the left 2 is the picked bar. */
const ROW = 'flex items-center gap-12 min-h-34 pl-8 pr-8 border-l-2';
const ROW_COMPACT = 'flex flex-wrap items-center gap-x-12 gap-y-4 min-h-34 py-4 pl-8 pr-8 border-l-2';
/** The control: right edge, never wrapping on a desktop; one least button width so 끔|켬 and
 *  작게|보통|크게 buttons are the same size. */
const CONTROL = 'ml-auto flex shrink-0 items-center gap-8 [&_button]:min-w-56';
/** The phone: a long control (건물 둘레's four buttons) wraps its last button under, right-aligned. */
const CONTROL_COMPACT = 'ml-auto flex max-w-full flex-wrap items-center justify-end gap-8 [&_button]:min-w-56';

interface SettingRowProps {
  title: ReactNode;
  help?: ReactNode;
  /** The control, on the right edge. */
  children?: ReactNode;
  /** A small tag after the name (F11, 시험). */
  badge?: ReactNode;
  /** Left of the name (the 내 프사 face). */
  lead?: ReactNode;
  /** Under the row (an error, details). */
  note?: ReactNode;
  testId?: string;
  className?: string;
}

export function SettingRow({ title, help, children, badge, lead, note, testId, className = '' }: SettingRowProps) {
  const id = useId();
  const sink = useContext(SettingHintContext);
  const me = { id, title, help };
  const picked = sink?.picked === id;
  return (
    <div data-testid={testId} className={className}>
      <div
        data-setting-row
        data-picked={picked || undefined}
        tabIndex={-1}
        className={`${sink?.compact ? ROW_COMPACT : ROW} outline-none ${picked ? 'border-accent bg-active-bg' : 'border-transparent hover:bg-bg-dark'}`}
        onMouseEnter={() => sink?.hover(me)}
        onMouseLeave={() => sink?.hover(null)}
        onFocus={() => sink?.pick(me)}
        onPointerDown={() => sink?.pick(me)}
      >
        {lead}
        <p className={`m-0 text-base ${sink?.compact ? '' : 'min-w-0 truncate'}`}>{title}</p>
        {badge && <span className="shrink-0 border-2 border-border px-4 text-2xs text-text-muted">{badge}</span>}
        {children && (
          <div data-setting-control className={sink?.compact ? CONTROL_COMPACT : CONTROL}>
            {children}
          </div>
        )}
      </div>
      {note && <div className="pb-6 pl-10 pr-8">{note}</div>}
    </div>
  );
}

/** A group's name over its rows, with a rule to the right edge. */
export function SettingGroup({ title }: { title: ReactNode }) {
  return (
    <h3 className="m-0 flex h-22 items-center gap-8 pl-10 pr-8 pt-4 text-xs font-normal text-text-muted">
      {title}
      <span className="h-2 flex-1 bg-border" />
    </h3>
  );
}

interface ChoiceProps<T extends string | number | boolean> {
  /** The group's name for a screen reader (the row's title). */
  label: string;
  options: readonly T[];
  value: T | null;
  onPick(value: NoInfer<T>): void;
  text(value: NoInfer<T>): ReactNode;
  /** A data attribute each button carries with its value (runners pick by it). */
  attr?: `data-${string}`;
  disabled?: (value: NoInfer<T>) => boolean;
  tip?: (value: NoInfer<T>) => string;
}

/** One of a few: the pressed button is the value. ←/→ step through it (settingsKey). */
export function Choice<T extends string | number | boolean>({ label, options, value, onPick, text, attr, disabled, tip }: ChoiceProps<T>) {
  return (
    <div role="group" aria-label={label} data-choice className="flex items-center gap-4">
      {options.map((v) => {
        const on = v === value;
        return (
          <Button
            key={String(v)}
            size="sm"
            variant={on ? 'active' : 'default'}
            aria-pressed={on}
            {...(attr ? { [attr]: String(v) } : {})}
            disabled={disabled?.(v)}
            title={tip?.(v)}
            onClick={() => onPick(v)}
          >
            {text(v)}
          </Button>
        );
      })}
    </div>
  );
}

const OFF_ON = [false, true] as const;

/** 끔 | 켬, the same shape as every other choice. */
export function OnOff({ label, on, onChange, disabled }: { label: string; on: boolean; onChange(on: boolean): void; disabled?: boolean }) {
  return (
    <Choice
      label={label}
      options={OFF_ON}
      value={on}
      onPick={onChange}
      text={(v) => t(v ? 'opts.on' : 'opts.off')}
      disabled={disabled ? () => true : undefined}
    />
  );
}
