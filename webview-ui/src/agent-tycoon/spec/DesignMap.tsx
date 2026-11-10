/**
 * BRN K8 (project-brain §7): the parts the 아키텍처 그래프 gets for the design. The switch
 * (코드 · 설계 · 겹쳐 보기), the ghost card and the card mark, the number row of the four drifts
 * with the examples of the one opened, and the picked card's note. ArchCards.tsx lays them out.
 */
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { memo, useState } from 'react';

import type {
  MapBlock,
  MapDesign,
  MapDrift,
  MapDriftKind,
} from '../../../../core/src/agent-tycoon/spec/trace.js';
import { SPEC_CARD_ICON, SPEC_DESIGN_NOTE_MODULES } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { PixelIcon } from '../game/parts.js';
import { cellName } from './archCardsModel.js';
import {
  type CellMark,
  driftExamples,
  driftRow,
  type Ghost,
  MAP_VIEWS,
  type MapView,
} from './designMapModel.js';

const MARK_GLYPH = { agree: '✓', guess: '≈', none: '!' } as const satisfies Record<
  CellMark,
  string
>;

/** The mark on a code card (겹쳐 보기): a word on a desktop card, a glyph on a phone card. */
export const MarkTag = ({ mark, mobile }: { mark: CellMark; mobile: boolean }) => (
  <span
    className="ui-chip ui-notch dm-mark"
    data-mark={mark}
    data-testid="dm-mark"
    title={t(`brainDesignMap.mark.${mark}`)}
    aria-label={t(`brainDesignMap.mark.${mark}`)}
  >
    {mobile ? MARK_GLYPH[mark] : `${MARK_GLYPH[mark]} ${t(`brainDesignMap.mark.${mark}`)}`}
  </span>
);

export interface GhostData extends Record<string, unknown> {
  g: Ghost;
  picked: boolean;
  mobile: boolean;
}
export type GhostNode = Node<GhostData, 'ghost'>;

/** A module only the design plans: a dashed ghost card. */
export const GhostView = memo(function GhostView({ data }: NodeProps<GhostNode>) {
  const { g } = data;
  return (
    <div
      className="ui-card ac-card dm-ghost"
      role="button"
      aria-pressed={data.picked}
      data-selected={data.picked || undefined}
      data-testid="dm-ghost"
      data-id={g.id}
      data-mobile={data.mobile || undefined}
      title={g.paths.join('\n')}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="ac-card-head">
        <span className="ui-card-tile ac-tile">
          <PixelIcon name="flag" size={data.mobile ? SPEC_CARD_ICON.phone : SPEC_CARD_ICON.card} />
        </span>
        <span className="ac-card-title">
          <span className="ac-card-name">{g.label}</span>
          {!data.mobile && (
            <span className="ui-chip ui-notch ac-chip dm-mark" data-mark="ghost">
              {t('brainDesignMap.ghost')}
            </span>
          )}
        </span>
      </div>
      {!data.mobile && (
        <ul className="ui-dots ac-card-lines">
          {g.paths.slice(0, 2).map((p) => (
            <li key={p} className="truncate">
              {p}
            </li>
          ))}
          {g.paths.length > 2 && <li>+{g.paths.length - 2}</li>}
        </ul>
      )}
    </div>
  );
});

/** The switch: 코드 · 설계 · 겹쳐 보기, raised tab buttons. */
export function ViewSwitch({ view, onView }: { view: MapView; onView: (v: MapView) => void }) {
  return (
    <nav
      className="ui-subtabs dm-switch"
      role="tablist"
      aria-label={t('brainDesignMap.nav')}
      data-testid="dm-switch"
      data-view={view}
    >
      {MAP_VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          className="ui-tab ui-raise shrink-0 text-sm pointer-coarse:min-h-44"
          onClick={() => onView(v)}
          data-testid="dm-view"
          data-view={v}
        >
          {t(`brainDesignMap.view.${v}`)}
        </button>
      ))}
    </nav>
  );
}

/**
 * The number row under the map and the examples of the one opened. An example opens the card it
 * names (a code card, a ghost), when it is on the map.
 * ponytail: top level only: the server's drift reads the top fold, so the row is not shown inside a sub-map.
 */
export function DriftBar({
  drift,
  blocks,
  design,
  known,
  onOpen,
}: {
  drift: MapDrift;
  blocks: readonly MapBlock[];
  design: MapDesign;
  /** The card ids on the map now. */
  known: ReadonlySet<string>;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState<MapDriftKind | null>(null);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const name = (id?: string) => (id && byId.has(id) ? cellName(byId.get(id)!) : (id ?? ''));
  const label = new Map(design.modules.map((m) => [m.id, m.label]));
  const examples = open ? driftExamples(drift, open) : [];
  return (
    <div className="dm-bar" data-testid="dm-bar">
      <div className="dm-row" role="group" aria-label={t('brainDesignMap.row')}>
        {driftRow(drift).map(({ kind, n }) => (
          <button
            key={kind}
            type="button"
            className="ui-chip ui-raise dm-num pointer-coarse:min-h-44"
            aria-pressed={open === kind}
            data-on={open === kind || undefined}
            data-zero={n === 0 || undefined}
            data-kind={kind}
            data-n={n}
            data-testid="dm-num"
            onClick={() => setOpen(open === kind ? null : kind)}
          >
            <span>{t(`brainDesignMap.row.${kind}`)}</span>
            <strong>{n}</strong>
          </button>
        ))}
      </div>
      {open && (
        <ul className="ui-sunken dm-list" data-testid="dm-list" data-kind={open}>
          {!examples.length && <li className="cm-muted">{t('brainDesignMap.row.noExample')}</li>}
          {examples.map(({ key, item, target }) => {
            const text =
              item.kind === 'designOnly'
                ? t('brainDesignMap.ex.designOnly', {
                    label: label.get(item.module ?? '') ?? '',
                    path: item.path ?? '',
                  })
                : item.kind === 'codeOnly'
                  ? name(item.cell)
                  : t('brainDesignMap.ex.dep', {
                      from: name(item.from),
                      to: name(item.to),
                      count: item.imports ?? 0,
                    });
            const can = !!target && known.has(target);
            return (
              <li key={key}>
                <button
                  type="button"
                  className="ui-row dm-ex pointer-coarse:min-h-44"
                  disabled={!can}
                  title={can ? t('brainDesignMap.ex.open') : undefined}
                  onClick={() => target && onOpen(target)}
                  data-testid="dm-ex"
                  data-target={target}
                >
                  <span className="flex-1 min-w-0 truncate">{text}</span>
                  {can && <PixelIcon name="play" size={SPEC_CARD_ICON.small} />}
                </button>
              </li>
            );
          })}
          {drift.more > 0 && (
            <li className="cm-muted">{t('brainDesignMap.row.more', { count: drift.more })}</li>
          )}
        </ul>
      )}
    </div>
  );
}

/** The picked card's note: how it stands against the design, and the design modules it holds. */
export function DesignNote({ mark, modules }: { mark?: CellMark; modules: MapDesign['modules'] }) {
  return (
    <section className="ac-sec" data-testid="dm-note">
      <h4 className="ac-sec-title">
        <PixelIcon name="flag" /> {t('brainDesignMap.note.title')}
      </h4>
      {mark && <p className="text-xs">{t(`brainDesignMap.note.${mark}`)}</p>}
      {modules.length ? (
        <ul className="text-xs">
          {modules.slice(0, SPEC_DESIGN_NOTE_MODULES).map((m) => (
            <li key={m.id} className="flex gap-8 py-2 min-w-0">
              <span className="flex-1 min-w-0 truncate" title={m.paths.join('\n')}>
                {m.label}
              </span>
              <span className="cm-muted">
                {m.by ? t(`brainDesignMap.by.${m.by}`) : t('brainDesignMap.by.none')}
              </span>
            </li>
          ))}
          {modules.length > SPEC_DESIGN_NOTE_MODULES && (
            <li className="cm-muted">
              {t('brainDesignMap.note.more', { count: modules.length - SPEC_DESIGN_NOTE_MODULES })}
            </li>
          )}
        </ul>
      ) : (
        <p className="text-text-muted text-xs">{t('brainDesignMap.note.noModule')}</p>
      )}
    </section>
  );
}

/** The ghost's detail: what the design plans and where. */
export function GhostDetail({ g, onClose }: { g: Ghost; onClose: () => void }) {
  return (
    <div className="space-y-8 text-xs min-w-0" data-testid="dm-ghost-detail" data-id={g.id}>
      <div className="flex items-center gap-8 min-w-0">
        <span className="ui-card-tile">
          <PixelIcon name="flag" size={SPEC_CARD_ICON.card} />
        </span>
        <h3 className="ac-detail-name flex-1 min-w-0 truncate">{g.label}</h3>
        <button
          type="button"
          className="ac-close pointer-coarse:min-h-44 pointer-coarse:min-w-44"
          aria-label={t('spec.cards.close')}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <p className="text-text-muted">{t('brainDesignMap.ghost.hint')}</p>
      <section className="ac-sec">
        <h4 className="ac-sec-title">
          <PixelIcon name="list" /> {t('brainDesignMap.ghost.paths')}
        </h4>
        <ul className="font-mono break-all">
          {g.paths.map((p) => (
            <li key={p} className="py-2">
              {p}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
