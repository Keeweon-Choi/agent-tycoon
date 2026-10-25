import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Checkbox } from '../../components/ui/Checkbox.js';
import { Modal } from '../../components/ui/Modal.js';
import { t } from '../../i18n/index.js';
import { closeShell, type ShellRow } from '../shell/shellApi.js';
import { AuditSection } from './AuditSection.js';
import {
  ago,
  authFetch,
  daysLeft,
  type Me,
  methodLabel,
  passkeyError,
  registerPasskey,
  SECTION,
  verifyPasskey,
} from './authApi.js';
import { forgetDevice } from './deviceKey.js';
import { deviceKindKey, devicePathKey } from './deviceListView.js';
import { Relogin } from './Relogin.js';
import { RemoteSection } from './Remote.js';

interface PasskeyRow {
  id: string;
  rpID: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** S5: the device it is tied to; null = "기기 미지정", deleted at `expiresAt`. */
  deviceId: string | null;
  expiresAt?: number;
}

/** A device (with its key) or a session without one (T-0034). */
interface SessionRow {
  id: string;
  method: string;
  label: string;
  /** The User-Agent label, even where `label` is an owner nickname. */
  device: string;
  kind: string;
  path: string;
  createdAt: number;
  lastSeen: number;
  current: boolean;
  connected: boolean;
  deviceKey: boolean;
  /** Web Push on for this device (absent: this daemon has no push). */
  push?: boolean;
  origin?: string;
  /** S5: passkeys tied to it; signing it out turns them off. */
  passkeys: number;
}

/**
 * An action's result, shown next to the control that was pressed (`at`): 'passkeys',
 * 'required', 'others', 'move', `passkey:<id>`, `row:<id>`; 'top' for a load error.
 * A lost-key note gets its way out beside it (`Relogin`).
 */
interface Note {
  text: string;
  at: string;
}

/** The window's width: a fixed one, because a shrink-wrapped window grew to its longest unbroken line while the column stayed narrow. */
const SECURITY_WIDTH = 'w-[min(640px,100%)]';
/** "보안" in the top bar (T-0022): passkeys and the logged-in devices. */
export function SecurityButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" className="shrink-0" onClick={() => setOpen(true)}>
        {t('auth.security')}
      </Button>
      {open && <SecurityModal onClose={() => setOpen(false)} />}
    </>
  );
}

/** Passkeys, "패스키(생체 인증) 필수", and the logged-in devices (T-0022, T-0034). */
export function SecurityModal({ onClose }: { onClose: () => void }) {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [rpID, setRpID] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  /** T-0052: open shells, by device row (none when the host has no --allow-terminal). */
  const [shells, setShells] = useState<ShellRow[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  // AUTH-PK2: on a phone the panel is taller than the screen; the note comes into view.
  // A block body: newer Chromium returns a promise from scrollIntoView, which React would take for a cleanup.
  useEffect(() => {
    noteRef.current?.scrollIntoView({ block: 'nearest' });
  }, [note]);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  /** O3: bumped when an action ran, so the record reloads from the top. */
  const [auditTick, setAuditTick] = useState(0);

  const load = useCallback(() => {
    setAuditTick((n) => n + 1);
    Promise.all([
      authFetch<{ rpID: string | null; passkeys: PasskeyRow[] }>('/api/auth/passkeys'),
      authFetch<{ sessions: SessionRow[] }>('/api/auth/sessions'),
      authFetch<Me>('/api/auth/me'),
      authFetch<{ shells: ShellRow[] }>('/api/shell').catch(() => ({ shells: [] })),
    ]).then(
      ([keys, list, self, open]) => {
        setShells(open.shells);
        setPasskeys(keys.passkeys);
        setRpID(keys.rpID);
        setSessions(list.sessions);
        setMe(self);
      },
      (err: unknown) => setNote({ text: err instanceof Error ? err.message : String(err), at: 'top' }),
    );
  }, []);
  useEffect(load, [load]);

  const run = async (what: () => Promise<unknown>, done: string, at: string) => {
    setBusy(true);
    setNote(null);
    try {
      await what();
      setNote({ text: done, at });
    } catch (err) {
      setNote({ text: passkeyError(err), at });
    } finally {
      setBusy(false);
      load();
    }
  };

  /** The note, when it belongs `at` this place (`orphan`: its row is gone, so here). */
  const noteAt = (at: string, orphan = false): ReactNode =>
    note &&
    (note.at === at || orphan) && (
      <div ref={noteRef} className="flex flex-col gap-6">
        <p className="text-sm m-0" role="status" data-testid="security-note">
          {note.text}
        </p>
        <Relogin note={note.text} />
      </div>
    );
  /** The note is about a row (`prefix<id>`) that is no longer listed. */
  const orphaned = (prefix: string, ids: string[]) =>
    !!note?.at.startsWith(prefix) && !ids.includes(note.at.slice(prefix.length));

  const canRegister = rpID !== null && browserSupportsWebAuthn();
  return (
    <Modal isOpen onClose={onClose} title={t('auth.security')} zIndex={60} className={SECURITY_WIDTH}>
      <div className="px-10 pb-10 flex flex-col gap-12" data-testid="security">
        {noteAt('top')}
        <section className={SECTION} data-testid="devices-section">
          <h3 className="text-base m-0">{t('auth.signedInDevices')}</h3>
          <p className="text-xs text-text-muted m-0">
            {t('auth.deviceKeyInfo')}
          </p>
          {sessions.map((s) => (
            <Fragment key={s.id}>
            <div
              className="flex items-center gap-8 border-t border-border pt-6"
              data-testid="session-row"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">
                  {s.label}
                  {s.current && <span className="text-accent-text">{t('auth.thisDeviceSuffix')}</span>}
                </div>
                <div className="text-xs text-text-muted truncate">
                  {t(deviceKindKey(s.kind))}
                  {/* The device label only under a nickname: without one it is the line above. */}
                  {s.device !== s.label && ` · ${s.device}`}
                </div>
                <div className="text-xs text-text-muted">
                  {methodLabel(s.method)}
                  {s.deviceKey && t('auth.autoLoginSuffix')}
                  {s.push !== undefined && t(s.push ? 'auth.pushOn' : 'auth.pushOff')} ·{' '}
                  {s.connected ? t('auth.connectedNow') : t('auth.lastSeen', { time: ago(s.lastSeen) })}
                </div>
                <div
                  className="text-xs text-text-muted truncate"
                  title={s.origin ? new URL(s.origin).host : undefined}
                >
                  {t(devicePathKey(s.path))}
                </div>
                {s.deviceKey &&
                  (renaming === s.id ? (
                    <div className="flex items-center gap-6 mt-2">
                      <input
                        value={nickname}
                        maxLength={40}
                        onChange={(e) => setNickname(e.target.value)}
                        className="min-w-0 flex-1 bg-bg-dark border-2 border-border px-6 text-sm"
                        aria-label={t('auth.renameDevice')}
                        autoFocus
                      />
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              authFetch(`/api/auth/sessions/${encodeURIComponent(s.id)}/nickname`, {
                                method: 'POST',
                                body: { name: nickname },
                              }).then(() => setRenaming(null)),
                            t('auth.deviceRenamed'),
                            `row:${s.id}`,
                          )
                        }
                      >
                        {t('auth.renameSave')}
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => setRenaming(null)}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      className="mt-2"
                      disabled={busy}
                      onClick={() => {
                        setNickname(s.label);
                        setRenaming(s.id);
                      }}
                    >
                      {t('auth.renameDevice')}
                    </Button>
                  ))}
                {shells
                  .filter((shell) => shell.deviceId === s.id)
                  .map((shell) => (
                    <div
                      key={shell.id}
                      className="flex items-center gap-6 text-xs mt-2"
                      data-testid="session-shell"
                    >
                      <span className="min-w-0 truncate">{t('auth.terminal', { path: shell.cwd })}</span>
                      <Button
                        size="sm"
                        className="shrink-0"
                        disabled={busy}
                        onClick={() => void run(() => closeShell(shell.id), t('auth.terminalClosed'), `row:${s.id}`)}
                      >
                        {t('common.close')}
                      </Button>
                    </div>
                  ))}
              </div>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (s.passkeys > 0 && !window.confirm(t('auth.signOutPasskeysConfirm', { name: s.label, count: s.passkeys }))) return;
                  void run(
                    () =>
                      authFetch(`/api/auth/sessions/${encodeURIComponent(s.id)}`, {
                        method: 'DELETE',
                      }).then(async () => {
                        // Its key is gone on the server: this browser's copy goes too.
                        if (s.current) await forgetDevice();
                        if (s.current) window.location.reload();
                      }),
                    t('auth.signedOut', { name: s.label }),
                    `row:${s.id}`,
                  );
                }}
              >
                {t('auth.signOut')}
              </Button>
            </div>
            {noteAt(`row:${s.id}`)}
            </Fragment>
          ))}
          {noteAt('', orphaned('row:', sessions.map((s) => s.id)))}
          <Button
            size="sm"
            disabled={busy || sessions.filter((s) => !s.current).length === 0}
            onClick={() => {
              const lost = sessions.filter((s) => !s.current).reduce((sum, s) => sum + s.passkeys, 0);
              if (lost > 0 && !window.confirm(t('auth.signOutOthersPasskeysConfirm', { count: lost }))) return;
              void run(
                () => authFetch('/api/auth/sessions/revoke-others', { method: 'POST' }),
                t('auth.signedOutOthers'),
                'others',
              );
            }}
          >
            {t('auth.signOutOthers')}
          </Button>
          {noteAt('others')}
          {me?.moveTo && me.deviceId && (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { url } = await authFetch<{ url: string }>('/api/auth/move-code', {
                      method: 'POST',
                    });
                    window.location.assign(url);
                  }, t('auth.moving'), 'move')
                }
              >
                {t('auth.moveDeviceTo', { host: new URL(me.moveTo).host })}
              </Button>
              <p className="text-xs text-text-muted m-0">
                {t('auth.moveInfo')}
              </p>
              {noteAt('move')}
            </>
          )}
        </section>
        <section className={SECTION} data-testid="passkey-section">
          <h3 className="text-base m-0">{t('auth.passkeys')}</h3>
          <p className="text-xs text-text-muted m-0">{t('settabs.passkeysOptional')}</p>
          <p className="text-xs text-text-muted m-0">
            {t('auth.passkeyInfo')}{rpID ? t('auth.currentRp', { rp: rpID }) : ''}.
          </p>
          {passkeys.length === 0 && (
            <p className="text-sm text-text-muted m-0">{t('auth.noPasskeys')}</p>
          )}
          {passkeys.map((key) => (
            <Fragment key={key.id}>
              <PasskeyItem item={key} busy={busy} run={run} devices={sessions.filter((s) => s.deviceKey)} />
              {noteAt(`passkey:${key.id}`)}
            </Fragment>
          ))}
          <Button
            size="sm"
            variant={canRegister ? 'accent' : 'disabled'}
            disabled={!canRegister || busy}
            onClick={() => void run(registerPasskey, t('auth.passkeyRegistered'), 'passkeys')}
          >
            {t('auth.registerPasskey')}
          </Button>
          {noteAt('passkeys', orphaned('passkey:', passkeys.map((k) => k.id)))}
          {!canRegister && (
            <p className="text-xs text-text-muted m-0">
              {t('auth.registerUnavailable')}
            </p>
          )}
          {me?.deviceKeys && (
            <>
              <Checkbox
                checked={me.passkeyRequired}
                label={t('auth.passkeyRequired')}
                // On takes this device's own passkey here, tapped now (the server checks it).
                disabled={busy || (!me.passkeyRequired && (!me.ownPasskeyHere || !browserSupportsWebAuthn()))}
                onChange={() =>
                  void run(
                    async () => {
                      if (!me.passkeyRequired) await verifyPasskey();
                      await authFetch('/api/auth/settings', {
                        method: 'POST',
                        body: { passkeyRequired: !me.passkeyRequired },
                      });
                    },
                    me.passkeyRequired
                      ? t('auth.autoLoginRestored')
                      : t('auth.passkeyNeeded'),
                    'required',
                  )
                }
              />
              {!me.passkeyRequired && (
                <p className="text-xs text-text-muted m-0" data-testid="passkey-required-warning">
                  {t('auth.passkeyRequiredWarning')}
                </p>
              )}
              {me.passkeyRequired && (
                <Button
                  size="sm"
                  variant={me.passkeyHere && browserSupportsWebAuthn() ? 'accent' : 'disabled'}
                  disabled={!me.passkeyHere || !browserSupportsWebAuthn() || busy}
                  onClick={() =>
                    void run(async () => {
                      await verifyPasskey();
                      await authFetch('/api/auth/settings', {
                        method: 'POST',
                        body: { passkeyRequired: false },
                      });
                    }, t('auth.autoLoginRestored'), 'required')
                  }
                >
                  {t('auth.verifyPasskey')}
                </Button>
              )}
              {noteAt('required')}
              <p className="text-xs text-text-muted m-0">
                {t('auth.passkeyRequiredInfo')}
              </p>
            </>
          )}
        </section>

        <AuditSection refresh={auditTick} />
        <RemoteSection />
      </div>
    </Modal>
  );
}

function PasskeyItem({
  item,
  busy,
  run,
  devices,
}: {
  item: PasskeyRow;
  busy: boolean;
  run: (what: () => Promise<unknown>, done: string, at: string) => Promise<void>;
  devices: SessionRow[];
}) {
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState('');
  const [name, setName] = useState(item.name);
  const path = `/api/auth/passkeys/${encodeURIComponent(item.id)}`;
  const at = `passkey:${item.id}`;
  return (
    <div className="flex items-center gap-8 border-t border-border pt-6" data-testid="passkey-row">
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-bg-dark border-2 border-border px-6 text-sm"
            aria-label={t('auth.passkeyName')}
            autoFocus
          />
        ) : (
          <div className="text-sm truncate">{item.name}</div>
        )}
        <div className="text-xs text-text-muted truncate">
          {item.rpID} · {item.lastUsedAt ? t('auth.lastUsed', { time: ago(item.lastUsedAt) }) : t('auth.neverUsed')}
        </div>
        {item.deviceId === null ? (
          <div className="flex flex-col gap-4 mt-2" data-testid="passkey-unbound">
            <div className="text-xs text-amber-400">
              {t('auth.passkeyUnbound', { days: daysLeft(item.expiresAt ?? 0) })}
            </div>
            <div className="text-xs text-text-muted">{t('auth.passkeyUnboundInfo')}</div>
            <div className="flex items-center gap-6">
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="min-w-0 flex-1 bg-bg-dark border-2 border-border px-6 text-xs"
                aria-label={t('auth.passkeyAssignPick')}
              >
                <option value="">{t('auth.passkeyAssignPick')}</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={busy || !target}
                onClick={() =>
                  void run(
                    () => authFetch(`${path}/device`, { method: 'POST', body: { deviceId: target } }),
                    t('auth.passkeyAssigned'),
                    at,
                  )
                }
              >
                {t('auth.passkeyAssign')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-xs text-text-muted truncate">
            {t('auth.passkeyOf', { name: devices.find((d) => d.id === item.deviceId)?.label ?? '?' })}
          </div>
        )}
      </div>
      {editing ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setEditing(false);
            void run(() => authFetch(path, { method: 'PATCH', body: { name } }), t('auth.nameChanged'), at);
          }}
        >
          {t('engine.save')}
        </Button>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>
          {t('auth.nameButton')}
        </Button>
      )}
      <Button
        size="sm"
        disabled={busy}
        onClick={() => {
          if (window.confirm(t('auth.deletePasskeyConfirm', { name: item.name })))
            void run(() => authFetch(path, { method: 'DELETE' }), t('auth.passkeyDeleted'), at);
        }}
      >
        {t('auth.delete')}
      </Button>
    </div>
  );
}
