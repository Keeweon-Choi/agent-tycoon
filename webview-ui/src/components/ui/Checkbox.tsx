import type { ReactNode } from 'react';

import { Icon } from '../../cld/icons/Icon.js';
import { useUiTheme } from '../../cld/uiTheme.js';

interface CheckboxProps {
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  className?: string;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, label, className = '', disabled = false }: CheckboxProps) {
  // The pixel 'x' sits a font pixel off centre; the outline check is centred.
  const nudge = useUiTheme() === 'pixel' ? 'pl-1.5 pb-4' : '';
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`flex items-center justify-between w-full py-6 px-10 bg-transparent border-none rounded-ui-card text-left ${disabled ? 'opacity-50 cursor-default' : 'cursor-pointer hover:bg-btn-bg'} ${className}`}
    >
      <span>{label}</span>
      <span
        className={`w-14 h-14 border-ui rounded-ui-chip shrink-0 flex items-center justify-center text-2xs ${nudge} leading-none text-white ${checked ? 'bg-accent border-devroom-tab-on ui-bevel' : 'bg-devroom-menu border-border ui-sunken'}`}
      >
        {checked ? <Icon name="check" size={12} pixel="x" /> : ''}
      </span>
    </button>
  );
}
