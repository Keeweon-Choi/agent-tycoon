import { describe, expect, it } from 'vitest';

import { OWNER_CHARACTER_ID } from '../constants.js';
import { OfficeState } from '../office/engine/officeState.js';
import { phoneTapCharacter } from './phoneTap.js';

const office = () => {
  const os = new OfficeState();
  os.addAgent(1, 0, 0, undefined, true);
  os.addAgent(2, 0, 0, undefined, true);
  return os;
};

describe('phoneTapCharacter', () => {
  it('a first tap selects and follows, and opens no sheet', () => {
    const os = office();
    expect(phoneTapCharacter(os, 1)).toBe('select');
    expect(os.selectedAgentId).toBe(1);
    expect(os.cameraFollowId).toBe(1);
    expect(os.infoAgentId).toBeNull();
  });

  it('a second tap on the selected character opens its sheet', () => {
    const os = office();
    phoneTapCharacter(os, 1);
    expect(phoneTapCharacter(os, 1)).toBe('info');
    expect(os.infoAgentId).toBe(1);
    expect(os.selectedAgentId).toBe(1);
  });

  it('a tap on another character selects it only and closes the sheet', () => {
    const os = office();
    phoneTapCharacter(os, 1);
    phoneTapCharacter(os, 1);
    expect(phoneTapCharacter(os, 2)).toBe('select');
    expect(os.selectedAgentId).toBe(2);
    expect(os.infoAgentId).toBeNull();
  });

  it('empty floor clears the selection and with it the sheet', () => {
    const os = office();
    phoneTapCharacter(os, 1);
    phoneTapCharacter(os, 1);
    os.selectedAgentId = null;
    expect(os.infoAgentId).toBeNull();
  });

  it('closing the sheet keeps the character selected', () => {
    const os = office();
    phoneTapCharacter(os, 1);
    phoneTapCharacter(os, 1);
    os.setInfoAgent(null);
    expect(os.selectedAgentId).toBe(1);
    expect(os.infoAgentId).toBeNull();
  });

  it('a sheet cannot be opened for a character that is not selected', () => {
    const os = office();
    os.setInfoAgent(2);
    expect(os.infoAgentId).toBeNull();
  });

  it("the owner's own character has no sheet", () => {
    const os = office();
    os.addAgent(OWNER_CHARACTER_ID, 0, 0, undefined, true);
    const owner = os.characters.get(OWNER_CHARACTER_ID);
    if (owner) owner.agtyOwner = true;
    phoneTapCharacter(os, OWNER_CHARACTER_ID);
    expect(phoneTapCharacter(os, OWNER_CHARACTER_ID)).toBe('select');
    expect(os.infoAgentId).toBeNull();
  });

  it('tells its listeners when the sheet opens and closes', () => {
    const os = office();
    let calls = 0;
    os.subscribeSelection(() => calls++);
    phoneTapCharacter(os, 1);
    const afterSelect = calls;
    phoneTapCharacter(os, 1);
    os.setInfoAgent(null);
    expect(calls).toBe(afterSelect + 2);
  });

  it('a selectAndFollow while the sheet is open moves the sheet to the new character (one notification)', () => {
    const os = office();
    phoneTapCharacter(os, 1);
    phoneTapCharacter(os, 1);
    const seen: Array<[number | null, number | null]> = [];
    os.subscribeSelection(() => seen.push([os.selectedAgentId, os.infoAgentId]));
    expect(os.selectAndFollow(2)).toBe(true);
    expect(os.selectedAgentId).toBe(2);
    expect(os.cameraFollowId).toBe(2);
    expect(os.infoAgentId).toBe(2);
    expect(seen).toEqual([[2, 2]]);
  });

  it('a selectAndFollow with no sheet open opens none', () => {
    const os = office();
    phoneTapCharacter(os, 1);
    os.selectAndFollow(2);
    expect(os.selectedAgentId).toBe(2);
    expect(os.infoAgentId).toBeNull();
  });

  it('a selectAndFollow of the owner closes the sheet and opens none', () => {
    const os = office();
    os.addAgent(OWNER_CHARACTER_ID, 0, 0, undefined, true);
    const owner = os.characters.get(OWNER_CHARACTER_ID);
    if (owner) owner.agtyOwner = true;
    phoneTapCharacter(os, 1);
    phoneTapCharacter(os, 1);
    expect(os.selectAndFollow(OWNER_CHARACTER_ID)).toBe(true);
    expect(os.selectedAgentId).toBe(OWNER_CHARACTER_ID);
    expect(os.infoAgentId).toBeNull();
  });

  it('a selectAndFollow that is refused (away, or no such character) leaves the open sheet as it was', () => {
    const os = office();
    phoneTapCharacter(os, 1);
    phoneTapCharacter(os, 1);
    const away = os.characters.get(2);
    if (away) away.agtyAway = true;
    expect(os.selectAndFollow(2)).toBe(false);
    expect(os.selectAndFollow(99)).toBe(false);
    expect(os.selectedAgentId).toBe(1);
    expect(os.infoAgentId).toBe(1);
  });

  it('a selectAndFollow of the character whose sheet is open keeps it', () => {
    const os = office();
    phoneTapCharacter(os, 1);
    phoneTapCharacter(os, 1);
    os.selectAndFollow(1);
    expect(os.infoAgentId).toBe(1);
  });
});
