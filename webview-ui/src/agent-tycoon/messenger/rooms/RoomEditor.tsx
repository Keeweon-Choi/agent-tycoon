import { useState } from 'react';

import { Button } from '../../../components/ui/Button.js';
import { t } from '../../../i18n/index.js';

export function RoomEditor({
  members,
  title,
  initialName = '',
  initialMembers = [],
  submit,
  cancel,
}: {
  members: string[];
  title: string;
  initialName?: string;
  initialMembers?: string[];
  submit: (name: string, members: string[]) => void;
  cancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState(() => new Set(initialMembers));
  return (
    <form
      className="mx-8 mb-8 p-10 space-y-6 text-xs rounded-ui-win border-ui border-devroom-card-line bg-surface-card shadow-pixel"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) submit(name, [...selected]);
      }}
    >
      <strong className="text-sm text-devroom-title">{title}</strong>
      <input
        aria-label={t('messenger.roomName')}
        value={name}
        maxLength={40}
        onChange={(event) => setName(event.target.value)}
        className="ui-input w-full px-8 py-4 text-sm"
      />
      <fieldset>
        <legend className="text-text-muted">{t('messenger.members')}</legend>
        <div className="flex flex-wrap gap-x-8 gap-y-4 mt-4">
          {members.map((member) => (
            <label key={member} className="flex items-center gap-4 px-6 py-2 rounded-ui-chip border-ui border-border pointer-coarse:min-h-44">
              <input
                type="checkbox"
                checked={selected.has(member)}
                onChange={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(member)) next.delete(member);
                    else next.add(member);
                    return next;
                  })
                }
              />
              {member}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex gap-4 justify-end">
        <Button size="sm" onClick={cancel}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="accent" type="submit" disabled={!name.trim()}>
          {t('engine.save')}
        </Button>
      </div>
    </form>
  );
}
