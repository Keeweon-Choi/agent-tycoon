/**
 * T-74: an error boundary per region (the root, each HUD window and phone page, the office HUD, the party,
 * settings). A render error in one shows a small card in its place: what broke, Reopen (mount the region
 * again) and Reload, while the rest of the page keeps running; the error goes to the daemon log.
 */
import type { ErrorInfo, ReactNode } from 'react';
import { Component, Fragment } from 'react';

import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import { isE2E } from '../runtime.js';
import { reportError } from './errorReport.js';
import type { WindowId } from './hud/layout.js';

export type Region = WindowId | 'root' | 'hud' | 'party' | 'member' | 'settings';

interface Props {
  region: Region;
  children: ReactNode;
  /** Where the card sits (the party's is a HUD panel on the right, the root's fills the screen). */
  className?: string;
}

interface State {
  error: Error | null;
  /** Bumped by Reopen: the region mounts afresh. */
  mount: number;
}

export function RegionCrash({
  region,
  error,
  onReopen,
  className = '',
}: {
  region: Region;
  error: Error;
  onReopen: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-testid="region-crash"
      data-region={region}
      className={`pixel-panel ui-window pointer-events-auto flex flex-col gap-8 p-12 max-w-[360px] ${className}`}
    >
      <strong>{t('crash.title', { region: t(`crash.region.${region}`) })}</strong>
      <span className="text-sm text-text-muted">{t('crash.detail')}</span>
      <code className="text-xs text-text-muted break-words line-clamp-3">{error.message}</code>
      <span className="flex gap-8">
        <Button size="sm" data-testid="region-reopen" onClick={onReopen}>
          {t('crash.reopen')}
        </Button>
        <Button size="sm" data-testid="region-reload" onClick={() => window.location.reload()}>
          {t('crash.reload')}
        </Button>
      </span>
    </div>
  );
}

/** Runners only (isE2E): a region named in `window.__AGENT_TYCOON_CRASH` throws while it renders. */
function CrashProbe({ region }: { region: Region }) {
  if ((window as unknown as { __AGENT_TYCOON_CRASH?: string }).__AGENT_TYCOON_CRASH === region)
    throw new Error(`test crash in ${region}`);
  return null;
}

export class RegionBoundary extends Component<Props, State> {
  state: State = { error: null, mount: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[Webview] ${this.props.region} crashed`, error);
    reportError('boundary', error, this.props.region, info.componentStack);
  }

  private reopen = () => this.setState((s) => ({ error: null, mount: s.mount + 1 }));

  render(): ReactNode {
    const { error, mount } = this.state;
    if (error)
      return (
        <RegionCrash
          region={this.props.region}
          error={error}
          onReopen={this.reopen}
          className={this.props.className}
        />
      );
    return (
      <Fragment key={mount}>
        {isE2E && <CrashProbe region={this.props.region} />}
        {this.props.children}
      </Fragment>
    );
  }
}
