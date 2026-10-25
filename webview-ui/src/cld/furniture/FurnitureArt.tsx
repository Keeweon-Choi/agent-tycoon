/**
 * CH-6b: a selected placed item's "edit art" and, for the user's own redrawn items, "remove".
 * The pixel editor opens on the item's sprite; a save makes a NEW item (the daemon picks its id
 * and builds its manifest) and the placed item switches to it, one undo step like any edit.
 */
import { useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { t } from '../../i18n/index.js';
import { getCatalogEntry } from '../../office/layout/furnitureCatalog.js';
import { PixelEditor } from '../characters/PixelEditor.js';
import { type Pixels, spriteRgba } from '../characters/sheetPixels.js';

const CUSTOM = /^custom-/;
const CATALOG_WAIT_MS = 5000;

/** The daemon's answer, or its error text thrown. */
async function call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
  return body;
}

export function FurnitureArt({
  uid,
  type,
  onSwitch,
}: {
  uid: string;
  type: string;
  onSwitch: (uid: string, type: string) => void;
}) {
  const [editing, setEditing] = useState<Pixels | null>(null);
  const [error, setError] = useState('');
  const base = type.replace(/:left$/, ''); // a mirrored copy is drawn from its own sprite
  const entry = getCatalogEntry(base);
  if (!entry) return null;
  const height = entry.sprite.length;
  const width = entry.sprite[0]?.length ?? 0;

  const save = async (png: string) => {
    const { id } = await call('cld/furniture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base, png }),
    });
    if (typeof id !== 'string') throw new Error('no id');
    // The new catalog comes on the socket, this answer over HTTP: either may land first.
    for (let waited = 0; !getCatalogEntry(id) && waited < CATALOG_WAIT_MS; waited += 100)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (getCatalogEntry(id)) onSwitch(uid, id);
  };

  const remove = async () => {
    if (!window.confirm(t('furnitureArt.removeConfirm', { name: entry.label }))) return;
    setError('');
    try {
      await call(`cld/furniture/${encodeURIComponent(base)}`, { method: 'DELETE' });
    } catch (err) {
      setError(
        t('furnitureArt.failed', { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  };

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex flex-wrap gap-4">
        <Button
          size="sm"
          data-testid="furniture-art-edit"
          onClick={() => setEditing(spriteRgba(entry.sprite))}
        >
          {t('furnitureArt.edit')}
        </Button>
        {CUSTOM.test(base) && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="furniture-art-remove"
            onClick={() => void remove()}
          >
            {t('furnitureArt.remove')}
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <Modal
        isOpen={!!editing}
        onClose={() => setEditing(null)}
        title={t('furnitureArt.title', { name: entry.label })}
      >
        <p className="text-xs text-text-muted px-12 pb-6">{t('furnitureArt.hint')}</p>
        {editing && (
          <PixelEditor
            name={base}
            start={editing}
            canSave
            onBack={() => setEditing(null)}
            onSaved={() => setEditing(null)}
            art={{ width, height, save }}
          />
        )}
      </Modal>
    </div>
  );
}
