import type { ButtonHTMLAttributes } from 'react';

const base = 'border-2 rounded-none cursor-pointer';

// UI-CONSISTENCY: one height per size (sm = every row's and panel's button, md = a dialog's
// main action), text centred, one line, a 44 px target on touch.
const fixed =
  'inline-flex items-center justify-center gap-4 whitespace-nowrap p-0 disabled:cursor-default disabled:opacity-(--btn-disabled-opacity)';
const sizes = {
  sm: `${fixed} h-28 px-8 text-sm pointer-coarse:min-h-44`,
  md: `${fixed} h-32 px-12 pointer-coarse:min-h-44`,
  lg: 'py-3 px-14 text-lg',
  xl: 'py-6 px-24 text-xl',
  icon: 'p-0 w-16 h-16 flex items-center justify-center',
  // UI-AUDIT-DESKTOP: the one icon button of a window header, toolbar, row and the top bar:
  // 28 square (the height of `sm`, so a row of icons and text buttons lines up), its glyph 16 px
  // (svg or Material symbol) or one line of text, centred. `icon` (16) stays for the tiny
  // overlays on the canvas and cards; `icon_lg` (40) is the dock.
  icon_md: `${fixed} size-28 shrink-0 text-sm leading-none pointer-coarse:min-w-44 pointer-coarse:min-h-44 [&>svg]:size-16 [&>.material-symbols-sharp]:text-[16px]`,
  icon_lg: 'p-0 w-40 h-40 flex items-center justify-center',
} as const;

const variants = {
  default: `${base} bg-btn-bg border-transparent hover:bg-btn-hover`,
  active: `${base} bg-active-bg border-accent`,
  disabled: `${base} bg-btn-bg border-transparent cursor-default opacity-[var(--btn-disabled-opacity)]`,
  accent: `${base} bg-accent! hover:bg-accent-bright! border-accent hover:border-accent-bright`,
  ghost: `${base} bg-transparent text-text-muted border-transparent hover:text-text`,
} as const;

type ButtonVariant = keyof typeof variants;
type ButtonSize = keyof typeof sizes;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'default',
  size = 'lg',
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
