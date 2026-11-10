// SPT-P3-ACCEPT: the acceptance store (round trip, 0600, atomic, append-only, purged with the spec
// folder), current / previous / 수용 재검토 per text version, 반려 needs a note, link review leaves
// acceptance alone, the item's text and 인수 기준 read now and masked, the summary counts, the route's
// guards, boundary and audit, and the repository bytes. TOKEN-GUARD (trace.test.ts) scans this folder.
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TraceItem } from '../../../../core/src/cld/spec/trace.js';
import { SPEC_ACCEPT_RECORDS_MAX, SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, type TempRepo } from '../engine/git/testRepo.js';
import { ENV_DUMP_NOTE, maskText } from '../mask.js';
import { purgeSpecData } from '../projectData.js';
import { acceptanceFile, acceptanceNow, type AcceptanceRecord, acceptanceWeek, emptyAcceptance, readAcceptance, writeAcceptance } from './acceptance.js';
import { criteriaOf, itemSource } from './extract.js';
import { registerSpecRoutes } from './routes.js';
import { type SpecProject, SpecService } from './service.js';
import type { TraceTask } from './trace.js';

/** Fake secrets for the masking probes, built at run time so a secret scanner never sees one
 *  in the source (GitHub push protection refused Stripe's documented example key, 11-04). */
const FAKE_STRIPE = ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_');
const FAKE_GH_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');

const PROJECT_ID = 'p_abcdefghij';
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
const SRS =
  '# SRS\n\n## 3.1 엔진\n\n| ID | 요구 | 인수 기준 |\n|---|---|---|\n' +
  `| FR-ENG-001 | 엔진이 세션을 이어 받는다 (키 ${TOKEN}) | 재시작 뒤 같은 세션<br>토큰 유지 |\n` +
  '| FR-ENG-002 | 엔진이 작업을 기록한다 | |\n';
const NONE = { change: 'none', integration: 'none', test: 'none', deploy: 'none', reported: false } as const;
const rec = (textHash: string, state: AcceptanceRecord['state'], at: string): AcceptanceRecord => ({ uid: 'r_aaaaaaaaaa', textHash, state, by: { kind: 'owner', name: 'owner' }, at, evidence: NONE });

let repo: TempRepo | null = null;
const homes: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = null;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const tempHome = () => {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-accept-')));
  homes.push(h);
  return h;
};

describe('the acceptance store', () => {
  it('round trips, 0600 in 0700, atomic; an unreadable file is corrupt', () => {
    const file = acceptanceFile(tempHome(), PROJECT_ID);
    expect(readAcceptance(file)).toEqual({ file: emptyAcceptance(), corrupt: null });
    const a = { ...emptyAcceptance(), rev: 2, records: [rec('h1', 'accepted', 'a')] };
    writeAcceptance(file, a);
    expect(readAcceptance(file)).toEqual({ file: a, corrupt: null });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['acceptance.json']);
    fs.writeFileSync(file, '{"v":1,"rev":1,"records":[{"uid":"x"}]}');
    expect(readAcceptance(file).corrupt).toMatch(/bad acceptance/);
  });

  it('current, previous and 수용 재검토: a text change starts again from 검토 전; changed back, its record counts again', () => {
    expect(acceptanceNow([], 'h1')).toEqual({ current: 'none', review: false });
    const v1 = [rec('h1', 'validate', '1'), rec('h1', 'accepted', '2')];
    expect(acceptanceNow(v1, 'h1')).toEqual({ current: 'accepted', review: false });
    expect(acceptanceNow(v1, 'h2')).toEqual({ current: 'none', previous: { state: 'accepted', at: '2' }, review: true });
    expect(acceptanceNow([...v1, rec('h2', 'rejected', '3')], 'h2')).toEqual({ current: 'rejected', review: false });
    // h1 accepted → h2 judged → back to h1: h1's own record, no review.
    expect(acceptanceNow([...v1, rec('h2', 'rejected', '3')], 'h1')).toEqual({ current: 'accepted', review: false });
    // Recording 검토 전 on h2 clears 수용 재검토.
    expect(acceptanceNow([...v1, rec('h2', 'none', '3')], 'h2')).toEqual({ current: 'none', review: false });
    // h1 → h2 judged → h3: the newest older version (h2) is the one shown.
    expect(acceptanceNow([...v1, rec('h2', 'rejected', '3')], 'h3')).toEqual({ current: 'none', previous: { state: 'rejected', at: '3' }, review: true });
  });

  it('review probe P4: a judgement withdrawn (reset to 검토 전 on h1) stays withdrawn after a text change', () => {
    const recs = [rec('h1', 'accepted', '1'), rec('h1', 'none', '2')];
    expect(acceptanceNow(recs, 'h1')).toEqual({ current: 'none', review: false });
    expect(acceptanceNow(recs, 'h2')).toEqual({ current: 'none', review: false });
  });

  it('GAME-UI-1 이번 주 수락: per local day the last record per requirement, Monday first, five past weeks, nothing older read', () => {
    const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
    const r = (uid: string, state: AcceptanceRecord['state'], when: string): AcceptanceRecord => ({ ...rec('h1', state, when), uid });
    const now = new Date(2026, 10, 3, 20); // Tuesday 11-03
    const recs = [
      r('a', 'accepted', at(2026, 9, 1)), // before the oldest week: the walk stops here
      r('a', 'accepted', at(2026, 9, 28)), // 5 weeks back (week of 09-28): the oldest counted
      r('a', 'accepted', 'not a date'), // skipped, never throws
      r('b', 'accepted', at(2026, 10, 26)), // last week
      r('c', 'accepted', at(2026, 10, 27)),
      r('a', 'accepted', at(2026, 11, 2, 9)), // Monday: a accepted then rejected → rejected
      r('a', 'rejected', at(2026, 11, 2, 10)),
      r('b', 'accepted', at(2026, 11, 2, 11)),
      r('c', 'validate', at(2026, 11, 3, 9)), // Tuesday: validate counts nowhere
      r('d', 'accepted', at(2026, 11, 3, 9)),
      r('d', 'none', at(2026, 11, 3, 10)), // withdrawn the same day: not counted
      r('e', 'accepted', at(2026, 11, 3, 11)),
      r('e', 'accepted', at(2026, 11, 3, 12)), // the same requirement twice in a day: once
    ];
    const w = acceptanceWeek(recs, now);
    expect(w.start).toBe('2026-11-02');
    expect(w.today).toBe(1);
    expect(w.days.slice(0, 3)).toEqual([
      { accepted: 1, rejected: 1 },
      { accepted: 1, rejected: 0 },
      { accepted: 0, rejected: 0 },
    ]);
    expect(w.weeks).toEqual([1, 0, 0, 0, 2]);
    expect(acceptanceWeek([], new Date(2026, 10, 8, 23))).toMatchObject({ start: '2026-11-02', today: 6, weeks: [0, 0, 0, 0, 0] });
  });
});

describe('인수 기준 and the item text', () => {
  it('a table column, Done when / Tests / 검증 lists, OpenSpec scenarios; a row comes with its header', () => {
    const lines = SRS.split('\n');
    const row = lines.findIndex((l) => l.includes('FR-ENG-001')) + 1;
    expect(criteriaOf(itemSource(SRS, row, 'row'), 'row')).toEqual(['재시작 뒤 같은 세션', '토큰 유지']);
    expect(criteriaOf(itemSource(SRS, row + 1, 'row'), 'row')).toEqual([]);
    expect(itemSource(SRS, row, 'row').split('\n')).toEqual([lines[4], lines[5], lines[row - 1]]);
    const spec = '# Spec\n\n## R-1 저장\n\n본문\n\n### Done when\n\n- 저장된다\n- [ ] 다시 읽힌다\n\n### 검증\n\n수동으로 연다\n\n#### Scenario: 빈 파일\n- **WHEN** 비었다\n- **THEN** 만든다\n\n## R-2 다음\n\n### Tests\n- 다른 것\n';
    expect(criteriaOf(itemSource(spec, 3, 'heading'), 'heading')).toEqual(['저장된다', '다시 읽힌다', '수동으로 연다', '빈 파일 - WHEN 비었다 - THEN 만든다']);
    expect(itemSource(spec, 3, 'heading')).not.toContain('R-2');
  });

  it('review probe P3: the block is masked whole first, so an env dump under Tests is hidden in 인수 기준 too', () => {
    const doc = `# Spec\n\n## R-1 저장\n\n본문\n\n### Tests\n\nSTRIPE_KEY=${FAKE_STRIPE}\nDB_HOST=prod.db.internal\nDB_USER=admin\nDB_NAME=billing\n\n#### Scenario: 키\n- token ${FAKE_GH_TOKEN}\n`;
    const criteria = criteriaOf(maskText(itemSource(doc, 3, 'heading')), 'heading');
    expect(criteria.join(' ')).not.toMatch(/sk_live_|prod\.db|ghp_/);
    expect(criteria[0]).toBe(ENV_DUMP_NOTE);
  });
});

type Task = TraceTask & { project: string };

async function setup() {
  repo = makeTempRepo();
  repo.write('docs/requirements/SRS.md', SRS);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS']);
  const home = tempHome();
  const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID };
  const tasks: Task[] = [{ id: 'T-1', project: 'alpha', title: '세션', status: 'doing' }];
  let clock = Date.now() + SPEC_SETTLE_MS * 2;
  const sent: unknown[] = [];
  const s = new SpecService({ home, projects: () => [project], broadcast: (m) => sent.push(m), run: repo.run, now: () => clock, later: () => undefined, idle: () => undefined, tasks: () => tasks, jobs: () => [] });
  expect(await s.enable(project, ['docs/requirements/SRS.md'])).toMatchObject({ ok: true });
  const items = (await s.items(project, {})) as { ok: true; value: { items: Array<{ uid: string; displayId?: string }> } };
  const uid = Object.fromEntries(items.value.items.map((i) => [i.displayId!, i.uid]));
  const tick = () => (clock += SPEC_SCAN_MIN_MS);
  const item = async (u: string): Promise<TraceItem> => {
    const r = await s.item(project, u);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  // A write's queue entry clears a microtask after it answers; until then scan() takes it for a running scan.
  const edit = async (from: string, to: string) => {
    await new Promise((r) => setImmediate(r));
    repo!.write('docs/requirements/SRS.md', fs.readFileSync(path.join(repo!.folder, 'docs/requirements/SRS.md'), 'utf-8').replace(from, to));
    tick();
  };
  /** 수용 판정 as the detail sends it: with the version the owner was just shown. */
  const acc = async (u: string, state: string, note?: string, device = 'x') => s.accept(project, { uid: u, state, ...(note !== undefined && { note }), version: (await item(u)).version }, device);
  return { repo, home, project, s, sent, uid, tick, item, edit, acc };
}

function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const st = fs.lstatSync(path.join(root, rel));
    if (st.isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  }
  return out;
}

describe.skipIf(!GIT_AVAILABLE)('acceptance per requirement version', () => {
  it('records per version, append-only; a text change is 수용 재검토 until judged again; changed back, the old judgement holds', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    const before = hashTree(t.repo.folder);
    expect(await t.acc(u, 'validate')).toMatchObject({ ok: true });
    expect(await t.acc(u, 'accepted', '확인함')).toMatchObject({ ok: true, value: { state: 'accepted', note: '확인함', evidence: NONE } });
    expect((await t.item(u)).node.state).toMatchObject({ acceptance: { current: 'accepted' }, freshness: 'current' });
    const file = acceptanceFile(t.home, PROJECT_ID);
    expect(readAcceptance(file).file.records.map((r) => r.state)).toEqual(['validate', 'accepted']);
    expect(t.sent.length).toBeGreaterThan(0);

    await t.edit('세션을 이어 받는다', '세션을 끊김 없이 이어 받는다');
    const changed = await t.item(u);
    expect(changed.node.state).toMatchObject({ acceptance: { current: 'none', previous: { state: 'accepted' } }, acceptanceReview: true, freshness: 'review' });
    expect(changed.node.state?.linkReview).toBeUndefined();
    expect(changed.acceptance?.map((a) => [a.state, a.current])).toEqual([
      ['accepted', false],
      ['validate', false],
    ]);
    expect(changed.history?.filter((h) => h.kind === 'acceptance').map((h) => h.action)).toEqual(['validate', 'accepted']);
    expect(await t.s.summary(t.project)).toMatchObject({ acceptance: { none: 2, validate: 0, accepted: 0, rejected: 0, review: 1 } });
    const filtered = (await t.s.items(t.project, { acceptance: 'review' })) as { ok: true; value: { items: Array<{ uid: string }> } };
    expect(filtered.value.items.map((i) => i.uid)).toEqual([u]);
    expect(await t.s.items(t.project, { acceptance: 'poem' })).toEqual({ ok: false, error: 'value' });

    await t.edit('세션을 끊김 없이 이어 받는다', '세션을 이어 받는다');
    expect((await t.item(u)).node.state).toMatchObject({ acceptance: { current: 'accepted' }, freshness: 'current' });
    expect((await t.item(u)).node.state?.acceptanceReview).toBeUndefined();
    expect(readAcceptance(file).file.records).toHaveLength(2); // nothing rewritten
    expect(hashTree(t.repo.folder)).toEqual(before); // no repository or .git byte (the edits above are the test's, undone)
  });

  it('반려 needs a note; a retired or unknown requirement is refused; a corrupt file is never written', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-002'];
    const version = (await t.item(u)).version;
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    const raw = (b: Record<string, unknown>) => t.s.accept(t.project, { uid: u, version, ...b }, 'x');
    expect(await raw({ state: 'rejected' })).toEqual({ ok: false, error: 'value' });
    expect(await raw({ state: 'rejected', note: '   ' })).toEqual({ ok: false, error: 'value' });
    expect(await raw({ state: 'rejected', note: 'x'.repeat(501) })).toEqual({ ok: false, error: 'value' });
    expect(await raw({ state: 'done' })).toEqual({ ok: false, error: 'value' });
    expect(await raw({ state: 'accepted', version: undefined })).toEqual({ ok: false, error: 'value' }); // the version is required
    expect(await raw({ state: 'accepted', uid: 'r_zzzzzzzzzz' })).toEqual({ ok: false, error: 'boundary' });
    expect(await raw({ state: 'rejected', note: `다시 ${TOKEN}` })).toMatchObject({ ok: true, value: { note: '다시 ***' } });
    await t.edit('| FR-ENG-002 | 엔진이 작업을 기록한다 | |\n', '');
    expect(await raw({ state: 'accepted' })).toEqual({ ok: false, error: 'stale' });
    const file = acceptanceFile(t.home, PROJECT_ID);
    fs.writeFileSync(file, 'nope');
    const again = new SpecService({ home: t.home, projects: () => [t.project], broadcast: () => undefined, run: t.repo.run });
    expect(await again.accept(t.project, { uid: t.uid['FR-ENG-001'], state: 'accepted', version }, 'x')).toEqual({ ok: false, error: 'corrupt' });
    expect(fs.readFileSync(file, 'utf-8')).toBe('nope');
  });

  it('[연결 검토함] clears 연결 재검토 only: acceptance and acceptance.json stay as they are', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    await t.acc(u, 'accepted');
    expect(await t.s.addLink(t.project, { from: u, to: 'T-1', rel: 'implements' }, 'x')).toMatchObject({ ok: true });
    await t.edit('세션을 이어 받는다', '세션을 늘 이어 받는다');
    expect((await t.item(u)).node.state).toMatchObject({ linkReview: true, acceptanceReview: true, freshness: 'review' });
    const bytes = fs.readFileSync(acceptanceFile(t.home, PROJECT_ID));
    expect(await t.s.reviewLinks(t.project, { uid: u }, 'x')).toMatchObject({ ok: true });
    const after = (await t.item(u)).node.state!;
    expect(after).toMatchObject({ acceptance: { current: 'none', previous: { state: 'accepted' } }, acceptanceReview: true, freshness: 'review' });
    expect(after.linkReview).toBeUndefined();
    expect(fs.readFileSync(acceptanceFile(t.home, PROJECT_ID))).toEqual(bytes);
    expect(await t.acc(u, 'accepted')).toMatchObject({ ok: true });
    expect((await t.item(u)).node.state).toMatchObject({ acceptance: { current: 'accepted' }, freshness: 'current' });
  });

  it("the detail's text and 인수 기준 are read now, masked, never stored; purged with the project's spec data", async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    const d = await t.item(u);
    expect(d.text).toContain('FR-ENG-001');
    expect(d.text).toContain('| ID | 요구 | 인수 기준 |');
    expect(d.text).not.toContain(TOKEN);
    expect(d.criteria).toEqual(['재시작 뒤 같은 세션', '토큰 유지']);
    expect((await t.item(t.uid['FR-ENG-002'])).criteria).toBeUndefined();
    await t.acc(u, 'accepted');
    const dir = path.dirname(acceptanceFile(t.home, PROJECT_ID));
    for (const f of fs.readdirSync(dir)) if (!f.endsWith('.gz')) expect(fs.readFileSync(path.join(dir, f), 'utf-8')).not.toMatch(/재시작 뒤|엔진이 세션/);
    fs.rmSync(path.join(t.repo.folder, 'docs/requirements/SRS.md'));
    t.tick();
    expect((await t.item(u)).text).toBeUndefined();
    expect(purgeSpecData(t.home, PROJECT_ID)).toEqual([]);
    expect(fs.existsSync(acceptanceFile(t.home, PROJECT_ID))).toBe(false);
  });
});

describe.skipIf(!GIT_AVAILABLE)('review probes: acceptance lands only on the text the owner saw', () => {
  const srsOf = (t: Awaited<ReturnType<typeof setup>>) => path.join(t.repo.folder, 'docs/requirements/SRS.md');
  const settled = (t: Awaited<ReturnType<typeof setup>>) => {
    const old = new Date(Date.now() - SPEC_SETTLE_MS * 4);
    fs.utimesSync(srsOf(t), old, old);
  };

  it('P1: the line edited after the owner read it, the scan due: 수락 with the seen version is stale, nothing recorded', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    const seen = await t.item(u);
    await t.edit('세션을 이어 받는다', '세션을 절대 이어 받지 않는다');
    expect(await t.s.accept(t.project, { uid: u, state: 'accepted', version: seen.version }, 'x')).toEqual({ ok: false, error: 'stale' });
    expect(fs.existsSync(acceptanceFile(t.home, PROJECT_ID))).toBe(false);
    const now = await t.item(u);
    expect(now.version).not.toBe(seen.version);
    expect(now.node.state?.acceptance?.current).toBe('none');
    expect(await t.s.accept(t.project, { uid: u, state: 'accepted', version: now.version }, 'x')).toMatchObject({ ok: true });
  });

  it('P2: the text shown live before the next scan is due: 수락 scans first, lands on the shown text, no 수용 재검토 after', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    await t.item(u);
    await new Promise((r) => setImmediate(r));
    t.repo.write('docs/requirements/SRS.md', fs.readFileSync(srsOf(t), 'utf-8').replace('세션을 이어 받는다', '세션을 새로 이어 받는다'));
    settled(t); // written a while ago: the forced scan reads it
    const seen = await t.item(u); // no tick: the Registry still has the old hash
    expect(seen.text).toContain('새로');
    expect(await t.s.accept(t.project, { uid: u, state: 'accepted', version: seen.version }, 'x')).toEqual({ ok: false, error: 'stale' }); // seen with the old hash: refused
    const fresh = await t.item(u);
    expect(fresh.text).toContain('새로');
    expect(await t.s.accept(t.project, { uid: u, state: 'accepted', version: fresh.version }, 'x')).toMatchObject({ ok: true });
    t.tick();
    const after = await t.item(u);
    expect(after.node.state?.acceptance).toEqual({ current: 'accepted' });
    expect(after.node.state?.acceptanceReview).toBeUndefined();
  });

  it('P2: a document still being written (bytes on disk not the scanned ones) is stale until it settles', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    await t.item(u);
    await new Promise((r) => setImmediate(r));
    fs.writeFileSync(srsOf(t), fs.readFileSync(srsOf(t), 'utf-8').replace('세션을 이어 받는다', '세션을 또 이어 받는다'));
    const future = new Date(Date.now() + SPEC_SETTLE_MS * 10); // newer than the service clock: not settled
    fs.utimesSync(srsOf(t), future, future);
    const seen = await t.item(u);
    expect(await t.s.accept(t.project, { uid: u, state: 'accepted', version: seen.version }, 'x')).toEqual({ ok: false, error: 'stale' });
    settled(t);
    // The refused 수락 scanned it (forced): the detail read again shows the new version, and that one lands.
    expect(await t.s.accept(t.project, { uid: u, state: 'accepted', version: seen.version }, 'x')).toEqual({ ok: false, error: 'stale' });
    expect(await t.acc(u, 'accepted')).toMatchObject({ ok: true });
    expect((await t.item(u)).node.state?.acceptance).toEqual({ current: 'accepted' });
  });

  it('B4: an edit to another row of the same document leaves an open acceptance valid, even while that file is still being written', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    const v = (await t.item(u)).version;
    await t.edit('엔진이 작업을 기록한다', '엔진이 작업을 늘 기록한다');
    expect(await t.s.accept(t.project, { uid: u, state: 'validate', version: v }, 'x')).toMatchObject({ ok: true });
    // Another row edited again, not settled (a newer mtime than the service clock): FR-ENG-001's own block is what counts.
    const v2 = (await t.item(u)).version;
    expect(v2).toBe(v);
    fs.writeFileSync(srsOf(t), fs.readFileSync(srsOf(t), 'utf-8').replace('엔진이 작업을 늘 기록한다', '엔진이 작업을 모두 기록한다'));
    const future = new Date(Date.now() + SPEC_SETTLE_MS * 10);
    fs.utimesSync(srsOf(t), future, future);
    expect(await t.s.accept(t.project, { uid: u, state: 'accepted', version: v2 }, 'x')).toMatchObject({ ok: true });
    // B2 holds: the token of FR-ENG-001's old text never passes once its own block changed.
    await t.edit('세션을 이어 받는다', '세션을 B4 이어 받는다');
    settled(t);
    expect(await t.s.accept(t.project, { uid: u, state: 'rejected', note: 'n', version: v2 }, 'x')).toEqual({ ok: false, error: 'stale' });
  });

  it("B5: an edit keeping the file's size and mtime is read again by 수락 (once refused as stale, then it lands)", async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    await t.item(u);
    await new Promise((r) => setImmediate(r));
    const st = fs.statSync(srsOf(t));
    const ref = path.join(t.home, 'mtime-ref');
    fs.writeFileSync(ref, '');
    execFileSync('touch', ['-r', srsOf(t), ref]); // touch keeps the sub-millisecond part utimes drops
    fs.writeFileSync(srsOf(t), fs.readFileSync(srsOf(t), 'utf-8').replace('세션을 이어', '세션을 잇고'));
    execFileSync('touch', ['-r', ref, srsOf(t)]);
    expect([fs.statSync(srsOf(t)).size, fs.statSync(srsOf(t)).mtimeMs]).toEqual([st.size, st.mtimeMs]);
    t.tick();
    const seen = await t.item(u); // the scan's shortcut: unchanged; the text read live shows the edit
    expect(seen.text).toContain('잇고');
    expect(await t.s.accept(t.project, { uid: u, state: 'accepted', version: seen.version }, 'x')).toEqual({ ok: false, error: 'stale' });
    const again = await t.item(u); // what the UI does on stale
    expect(again.version).not.toBe(seen.version);
    expect(await t.s.accept(t.project, { uid: u, state: 'accepted', version: again.version }, 'x')).toMatchObject({ ok: true });
    expect((await t.item(u)).node.state?.acceptance).toEqual({ current: 'accepted' });
  });

  it('P7: a link write still queued does not make 수락 judge the old text', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    const seen = await t.item(u);
    await t.edit('세션을 이어 받는다', '세션을 P7 이어 받는다');
    const link = t.s.addLink(t.project, { from: t.uid['FR-ENG-002'], to: 'T-1', rel: 'implements' }, 'x');
    const r = t.s.accept(t.project, { uid: u, state: 'accepted', version: seen.version }, 'x'); // arrives while the link write is queued
    expect(await link).toMatchObject({ ok: true });
    expect(await r).toEqual({ ok: false, error: 'stale' });
  });

  it('P3 in the detail: 원문 and 인수 기준 both hide an env dump under ### Tests', async () => {
    const t = await setup();
    t.repo.write('docs/requirements/R.md', `# Spec\n\n## R-1 저장\n\n본문\n\n### Tests\n\nSTRIPE_KEY=${FAKE_STRIPE}\nDB_HOST=prod.db.internal\nDB_USER=admin\nDB_NAME=billing\n`);
    t.tick();
    expect(await t.s.enable(t.project, ['docs/requirements/SRS.md', 'docs/requirements/R.md'])).toMatchObject({ ok: true });
    t.tick();
    const rows = (await t.s.items(t.project, {})) as { ok: true; value: { items: Array<{ uid: string; doc: string; line: number }> } };
    const d = await t.item(rows.value.items.find((i) => i.doc.endsWith('R.md') && i.line === 3)!.uid);
    expect(d.text).not.toContain('sk_live_');
    expect(JSON.stringify(d.criteria ?? [])).not.toMatch(/sk_live_|prod\.db/);
  });

  it('P5 in the detail: a token straddling the 2000-character line cap leaks none of its characters into 원문', async () => {
    const t = await setup();
    const tok = `ghp_${'Zq9'.repeat(12)}`;
    t.repo.write('docs/requirements/SRS.md', `${SRS}| FR-ENG-003 | ${'a'.repeat(1970)} ${tok} | |\n`);
    t.tick();
    const rows = (await t.s.items(t.project, {})) as { ok: true; value: { items: Array<{ uid: string; displayId?: string }> } };
    const d = await t.item(rows.value.items.find((i) => i.displayId === 'FR-ENG-003')!.uid);
    expect(d.text).not.toMatch(/ghp_|Zq9/);
  });

  it('the record cap: past SPEC_ACCEPT_RECORDS_MAX every write is refused (full), nothing deleted', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    const file = acceptanceFile(t.home, PROJECT_ID);
    writeAcceptance(file, { ...emptyAcceptance(), rev: 1, records: Array.from({ length: SPEC_ACCEPT_RECORDS_MAX }, (_, i) => ({ ...rec('h0', 'validate', String(i)), uid: u })) });
    const again = new SpecService({ home: t.home, projects: () => [t.project], broadcast: () => undefined, run: t.repo.run, tasks: () => [], jobs: () => [] });
    const v = ((await again.item(t.project, u)) as { ok: true; value: TraceItem }).value.version;
    expect(await again.accept(t.project, { uid: u, state: 'accepted', version: v }, 'x')).toEqual({ ok: false, error: 'full' });
    expect(readAcceptance(file).file.records).toHaveLength(SPEC_ACCEPT_RECORDS_MAX);
  });
});

describe.skipIf(!GIT_AVAILABLE)('the acceptance route', () => {
  async function app(opts: { readOnly?: boolean; host?: boolean } = {}) {
    const t = await setup();
    const server = Fastify();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    registerSpecRoutes(server, t.s, {
      auth: async (request, reply) => {
        if (request.headers['x-session'] !== 'ok') await reply.code(401).send('unauthorized');
      },
      kindOf: () => ({ host: !!opts.host, remote: false }),
      actorOf: () => 'Test phone',
      readOnly: !!opts.readOnly,
    });
    const same = { origin: 'http://localhost:80', host: 'localhost:80', 'x-session': 'ok' };
    const post = (payload: object, headers: Record<string, string> = same) => server.inject({ method: 'POST', url: '/api/cld/spec/alpha/acceptance', headers, payload });
    const audits = () => log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[agty spec]'));
    return { ...t, post, same, audits };
  }

  it('session only, same-origin, read-only refused; another project’s UID 403; 반려 without a note 400; audited by UID and state only', async () => {
    const t = await app();
    const u = t.uid['FR-ENG-001'];
    const body = { uid: u, state: 'accepted', note: 'secret-ish memo', version: (await t.item(u)).version };
    expect((await t.post(body, {})).statusCode).toBe(401);
    expect((await t.post(body, { ...t.same, origin: 'https://evil.example' })).json().errorCode).toBe('origin_mismatch');
    expect((await t.post({ ...body, uid: 'r_zzzzzzzzzz' })).statusCode).toBe(403);
    expect((await t.post({ uid: u, state: 'rejected', version: body.version })).statusCode).toBe(400);
    expect((await t.post({ uid: u, state: 'accepted' })).statusCode).toBe(400); // no version
    expect((await t.post({ ...body, version: '0123456789abcdef' })).json().errorCode).toBe('spec_stale');
    const ok = await t.post(body);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, state: 'accepted' });
    expect(t.audits()).toEqual([`[agty spec] accept device="Test phone" project="alpha" uid=${u} state=accepted`]);
    const jsonl = fs.readFileSync(path.join(t.home, '.config/agent-tycoon/audit.jsonl'), 'utf-8');
    expect((JSON.parse(jsonl.trim().split('\n').at(-1)!) as { detail: string }).detail).toBe(`accept ${PROJECT_ID} ${u} accepted`);
    expect(jsonl).not.toContain('secret-ish');
    const host = await app({ host: true });
    expect((await host.post(body)).json().errorCode).toBe('spec_session_only');
    const ro = await app({ readOnly: true });
    expect((await ro.post(body)).json().errorCode).toBe('read_only_mode');
  });
});
