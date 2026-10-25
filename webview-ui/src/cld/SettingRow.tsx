/**
 * UI-CONSISTENCY: the one row of 설정. Title and help on the left, the control on the right edge of
 * the content; a control that needs room (three or more buttons, a field) is `stacked`: its own
 * line under the text, the full width. A `lead` (a face) sits left of the text. The row never sets
 * its own width or padding: the tab panel does, so every row ends at the same edge.
 */
import type { ReactNode } from 'react';

interface SettingRowProps {
  title: ReactNode;
  help?: ReactNode;
  /** Right-aligned beside the text, or (stacked) full width under it. */
  children?: ReactNode;
  stacked?: boolean;
  /** Left of the text (the 내 프사 face). */
  lead?: ReactNode;
  /** More lines under the help (an error). */
  note?: ReactNode;
  testId?: string;
  className?: string;
}

export function SettingRow({
  title,
  help,
  children,
  stacked = false,
  lead,
  note,
  testId,
  className = '',
}: SettingRowProps) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-16 gap-y-6 ${className}`}
      data-testid={testId}
    >
      {lead}
      <div className="flex-1 basis-[12rem] min-w-0">
        <p className="text-base">{title}</p>
        {help && <p className="text-sm text-text-muted">{help}</p>}
        {note}
      </div>
      {children && (
        <div
          data-setting-control
          className={`flex flex-wrap gap-4 ${stacked ? 'w-full' : 'ml-auto justify-end'}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
