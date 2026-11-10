/**
 * FEAT-PARTY-V2: the party column's head, `파티 (8)` as in the mockup (ref-pc.png): it names the party
 * shown and its head count; a press opens the list of parties (pick one), 새 파티, and for a composed
 * party 인원 고르기, 이름 바꾸기 and 삭제 (asked once more). The default party is everyone and stays.
 */
import './party.css';

import { useRef, useState } from 'react';

import { PARTY_NAME_MAX } from '../../../../core/src/constants.js';
import type { SetParties } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { PixelIcon } from '../game/parts.js';
import { Icon } from '../icons/Icon.js';
import {
  ALL_PARTY,
  createParty,
  currentParty,
  deleteParty,
  newPartyId,
  type Party,
  renameParty,
  saveParties,
  selectParty,
  toggleMember,
  useParties,
  useSelectedParty,
} from './parties.js';
import { useDismiss } from './useDismiss.js';

const out = (m: SetParties) => transport.send(m);

type View = { at: 'list' } | { at: 'name'; id: string | null } | { at: 'members'; id: string };

export function PartyHead({
  ids,
  shown,
  nameOf,
  keyOf,
  canEdit,
  up = false,
}: {
  /** Everyone in the column (the default party). */
  ids: readonly number[];
  /** How many the party shown lists. */
  shown: number;
  nameOf: (id: number) => string;
  keyOf: (id: number) => string | undefined;
  /** A read-only client picks a party but composes none. */
  canEdit: boolean;
  /** The phone's strip: the list opens upward, to the right. */
  up?: boolean;
}) {
  const parties = useParties();
  const party = currentParty(parties, useSelectedParty());
  const [view, setShown] = useState<View | null>(null);
  const [sure, setSure] = useState(false);
  // Every move in the menu (and its close) forgets the armed 삭제: one press never deletes after a detour.
  const setView = (next: View | null) => {
    setShown(next);
    setSure(false);
  };
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setView(null);
  useDismiss(view !== null, ref, close);
  const label = party ? party.name : t('partyV2.head');
  return (
    <div ref={ref} className="party-head" data-up={up || undefined} data-testid="party-head">
      <button
        type="button"
        className="party-select"
        aria-haspopup="menu"
        aria-expanded={view !== null}
        title={t('partyV2.pick', { name: label, count: shown })}
        data-testid="party-select"
        data-party={party?.id ?? ALL_PARTY}
        data-count={shown}
        onClick={() => (view ? close() : setView({ at: 'list' }))}
      >
        <span className="party-select-name">{label}</span>
        <span className="party-select-count">({shown})</span>
      </button>
      {view && (
        <div
          className="party-menu ui-window pixel-panel"
          role="menu"
          aria-label={t('partyV2.menu')}
          data-testid="party-menu"
        >
          {view.at === 'list' && (
            <PartyList
              parties={parties}
              party={party}
              everyone={ids.length}
              sizeOf={(p) => ids.filter((id) => p.members.includes(keyOf(id) ?? '')).length}
              canEdit={canEdit}
              sure={sure}
              onPick={(id) => {
                selectParty(id);
                close();
              }}
              onNew={() => setView({ at: 'name', id: null })}
              onRename={() => party && setView({ at: 'name', id: party.id })}
              onMembers={() => party && setView({ at: 'members', id: party.id })}
              onDelete={() => {
                if (!party) return;
                if (!sure) return setSure(true);
                saveParties(deleteParty(parties, party.id), out);
                selectParty(null);
                close();
              }}
            />
          )}
          {view.at === 'name' && (
            <NameForm
              initial={view.id ? (parties.find((p) => p.id === view.id)?.name ?? '') : ''}
              onCancel={() => setView({ at: 'list' })}
              onSave={(name) => {
                if (view.id) {
                  saveParties(renameParty(parties, view.id, name), out);
                  return setView({ at: 'list' });
                }
                const id = newPartyId();
                const next = createParty(parties, name, id);
                if (next.length === parties.length) return setView({ at: 'list' });
                saveParties(next, out);
                selectParty(id);
                setView({ at: 'members', id });
              }}
            />
          )}
          {view.at === 'members' && (
            <MemberPicker
              ids={ids}
              party={parties.find((p) => p.id === view.id)}
              nameOf={nameOf}
              keyOf={keyOf}
              onToggle={(key) => saveParties(toggleMember(parties, view.id, key), out)}
              onDone={close}
            />
          )}
        </div>
      )}
    </div>
  );
}

function PartyList({
  parties,
  party,
  everyone,
  sizeOf,
  canEdit,
  sure,
  onPick,
  onNew,
  onRename,
  onMembers,
  onDelete,
}: {
  parties: Party[];
  party: Party | null;
  everyone: number;
  sizeOf: (p: Party) => number;
  canEdit: boolean;
  sure: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  onRename: () => void;
  onMembers: () => void;
  onDelete: () => void;
}) {
  const row = (id: string, name: string, count: number) => (
    <button
      key={id}
      type="button"
      role="menuitemradio"
      aria-checked={(party?.id ?? ALL_PARTY) === id}
      aria-current={(party?.id ?? ALL_PARTY) === id}
      className="party-row ui-row"
      data-testid="party-option"
      data-party={id}
      onClick={() => onPick(id)}
    >
      <span className="party-row-name">{name}</span>
      <span className="party-row-count">{count}</span>
    </button>
  );
  return (
    <>
      {row(ALL_PARTY, t('partyV2.all'), everyone)}
      {parties.map((p) => row(p.id, p.name, sizeOf(p)))}
      {canEdit && (
        <>
          <hr className="party-sep" />
          <button type="button" role="menuitem" className="party-row ui-row" data-testid="party-new" onClick={onNew}>
            <Icon name="plus" size={14} pixel={<span aria-hidden="true">+</span>} />
            {t('partyV2.new')}
          </button>
          {party && (
            <>
              <button type="button" role="menuitem" className="party-row ui-row" data-testid="party-members" onClick={onMembers}>
                <PixelIcon name="person" size={14} />
                {t('partyV2.members')}
              </button>
              <button type="button" role="menuitem" className="party-row ui-row" data-testid="party-rename" onClick={onRename}>
                {t('partyV2.rename')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="party-row ui-row party-danger"
                data-testid="party-delete"
                data-sure={sure || undefined}
                onClick={onDelete}
              >
                {sure ? t('partyV2.deleteSure', { name: party.name }) : t('partyV2.delete')}
              </button>
            </>
          )}
        </>
      )}
    </>
  );
}

function NameForm({ initial, onSave, onCancel }: { initial: string; onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <form
      className="party-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name);
      }}
    >
      <label className="party-form-label">
        {t('partyV2.name')}
        <input
          className="ui-input party-input"
          value={name}
          maxLength={PARTY_NAME_MAX}
          autoFocus
          data-testid="party-name"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <span className="party-form-buttons">
        <button type="button" className="party-row ui-row" onClick={onCancel}>
          {t('partyV2.cancel')}
        </button>
        <button type="submit" className="party-row ui-row party-ok" disabled={!name.trim()} data-testid="party-name-save">
          {t('partyV2.save')}
        </button>
      </span>
    </form>
  );
}

function MemberPicker({
  ids,
  party,
  nameOf,
  keyOf,
  onToggle,
  onDone,
}: {
  ids: readonly number[];
  party: Party | undefined;
  nameOf: (id: number) => string;
  keyOf: (id: number) => string | undefined;
  onToggle: (key: string) => void;
  onDone: () => void;
}) {
  if (!party) return null;
  const seen = new Set<string>();
  return (
    <>
      <span className="party-form-label">{t('partyV2.membersOf', { name: party.name })}</span>
      <div className="party-picks" data-testid="party-picks">
        {ids.map((id) => {
          const key = keyOf(id);
          // One row per member key (two figures can share one, an engine project and its session).
          if (key === undefined || seen.has(key)) return null;
          seen.add(key);
          const on = party.members.includes(key);
          return (
            <button
              key={id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              className="party-row ui-row"
              data-testid="party-pick"
              data-member={key}
              onClick={() => onToggle(key)}
            >
              <span className="party-check" data-on={on || undefined}>
                {on && <Icon name="check" size={12} pixel={<PixelIcon name="check" size={10} />} />}
              </span>
              <span className="party-row-name">{nameOf(id)}</span>
            </button>
          );
        })}
      </div>
      <button type="button" className="party-row ui-row party-ok" data-testid="party-members-done" onClick={onDone}>
        {t('partyV2.done')}
      </button>
    </>
  );
}

