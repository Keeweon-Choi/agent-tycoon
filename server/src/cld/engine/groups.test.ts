import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ALL_GROUP_ID, ALL_GROUP_NAME, groupsPath,GroupStore } from './groups.js';

let homes: string[] = [];
afterEach(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  homes = [];
});

const home = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-groups-'));
  homes.push(value);
  return value;
};

describe('GroupStore', () => {
  it('round-trips custom rooms with a versioned 0600 roster', () => {
    const h = home();
    const store = new GroupStore(h, () => ['beta', 'alpha'], () => '1234abcd');
    expect(store.create('출시팀', ['beta', 'alpha'])).toEqual({
      ok: true,
      value: { id: '1234abcd', name: '출시팀', members: ['beta', 'alpha'] },
    });
    expect(JSON.parse(fs.readFileSync(groupsPath(h), 'utf-8'))).toEqual({
      v: 1,
      groups: [{ id: '1234abcd', name: '출시팀', members: ['beta', 'alpha'] }],
    });
    expect(fs.statSync(groupsPath(h)).mode & 0o777).toBe(0o600);
    expect(new GroupStore(h, () => ['beta', 'alpha']).find('출시팀')).toEqual({
      id: '1234abcd',
      name: '출시팀',
      members: ['beta', 'alpha'],
    });
  });

  it('makes 전체 follow the current registry and does not permit editing it', () => {
    const h = home();
    const names = ['alpha'];
    const store = new GroupStore(h, () => names);
    expect(store.find(ALL_GROUP_ID)).toEqual({ id: ALL_GROUP_ID, name: ALL_GROUP_NAME, members: ['alpha'] });
    names.push('beta');
    expect(store.find(ALL_GROUP_NAME)?.members).toEqual(['alpha', 'beta']);
    expect(store.setMembers(ALL_GROUP_ID, ['alpha'])).toMatchObject({ ok: false });
    expect(store.rename(ALL_GROUP_ID, 'other')).toMatchObject({ ok: false });
    expect(store.remove(ALL_GROUP_ID)).toMatchObject({ ok: false });
  });

  it('never replaces a corrupt roster', () => {
    const h = home();
    const file = groupsPath(h);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken');
    const store = new GroupStore(h, () => ['alpha']);
    expect(store.error).toContain('손상');
    expect(store.create('출시팀', ['alpha'])).toMatchObject({ ok: false });
    expect(fs.readFileSync(file, 'utf-8')).toBe('{broken');
  });

  it('refuses room names that could break the header line', () => {
    const store = new GroupStore(home(), () => ['alpha']);
    for (const name of ["a'b", 'a]b', 'a[b', 'a\nb', 'a"b', 'x'.repeat(41), '  ', '전체'])
      expect(store.create(name, ['alpha']), name).toMatchObject({ ok: false });
    expect(store.create('출시 팀-2', ['alpha'])).toMatchObject({ ok: true });
  });
});
