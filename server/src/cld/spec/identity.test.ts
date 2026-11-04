// SPT-P1C: the identity ladder against R2's synthetic cases (F1-F16, the F17 folder move) and
// SPT 0.3's traps, with no file system or git (the service tests cover those). WRONG = an old
// UID on the wrong item: it must stay 0. Anything else that misses is a miss and fails too.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { bodyText, extract, fmIdOf } from './extract.js';
import { keyedHasher, type Mat, matchSnapshot, type Sketch, sketchOf, type SnapDoc, textMat } from './identity.js';
import type { DocRecord, ItemRecord } from './store.js';

type Files = Record<string, string>;
const OPTS = { kind: 'requirements', mode: 'auto', depth: 2, shortIds: false, idPatterns: [] } as const;
const H = keyedHasher(Buffer.alloc(32, 7));

/** A Registry and match cache in memory, stepped the way the service steps them. */
function world() {
  const reg = { docs: {} as Record<string, DocRecord>, items: {} as Record<string, ItemRecord> };
  const mats = new Map<string, Mat>();
  const sketches = new Map<string, Sketch>();
  let n = 0;
  const step = (files: Files, renames: Record<string, string> | null = {}, rev = `r${n}`) => {
    const docs: SnapDoc[] = Object.entries(files).map(([p, text]) => ({
      path: p,
      fmId: fmIdOf(text),
      sketch: sketchOf(text, H),
      items: extract(text, path.posix.basename(p), OPTS),
    }));
    const res = matchSnapshot(reg, {
      docs,
      renames: renames === null ? null : new Map(Object.entries(renames)),
      rev,
      at: '2026-11-03T00:00:00.000Z',
      hash: H,
      mat: (u) => mats.get(u) ?? null,
      sketch: (u) => sketches.get(u) ?? null,
      newDoc: (d) => {
        const uid = `d_${(++n).toString().padStart(10, 'a')}`;
        reg.docs[uid] = {
          path: d.path, kind: 'requirements', mode: 'auto', tracked: true, state: 'active', git: 'not-git', blob: '', size: 0, mtimeMs: 0,
          changedAt: '', pathHistory: [], decisions: [],
        };
        return uid;
      },
      newItem: () => `r_${(++n).toString().padStart(10, 'a')}`,
    });
    for (const d of docs) {
      const uid = res.docOf.get(d.path);
      if (!uid) continue;
      sketches.set(uid, d.sketch!);
      (res.itemsOf.get(uid) ?? []).forEach((u, i) => mats.set(u, textMat(H, d.items![i].body, bodyText(d.items![i].title), d.items![i].displayId)));
    }
    // Every item now: its key (display ID, else title), path, UID, state.
    return {
      res,
      items: docs.flatMap((d) => (res.itemsOf.get(res.docOf.get(d.path)!) ?? []).map((u, i) => ({ key: d.items![i].displayId ?? d.items![i].title, path: d.path, uid: u, state: reg.items[u].state }))),
    };
  };
  return { reg, step };
}

interface Case {
  name: string;
  before: Files;
  after: Files;
  renames?: Record<string, string> | null;
  /** keep:X = the UID of the before-item X; new; unresolved; notkeep = anything but an old UID. */
  expect: Record<string, string>;
  docs?: Record<string, string>;
}

/** Run one case; returns its result lines and how many WRONG it had. */
function runCase(c: Case): { ok: boolean; wrong: number; lines: string[] } {
  const w = world();
  const a = w.step(c.before, c.renames);
  const uidOf = new Map(a.items.map((x) => [x.key, x.uid]));
  const docOf = new Map(a.res.docOf);
  const b = w.step(c.after, c.renames);
  let ok = true;
  let wrong = 0;
  const lines: string[] = [];
  for (const [k, want] of Object.entries(c.expect)) {
    const d = b.items.find((x) => x.key === k || `${x.path}#${x.key}` === k);
    if (!d) {
      ok = false;
      lines.push(`${k}: MISSING`);
      continue;
    }
    const kept = [...uidOf].find(([, u]) => u === d.uid)?.[0];
    const res = d.state === 'unresolved' ? 'unresolved' : kept ? `keep:${kept}` : 'new';
    const pass = want === 'notkeep' ? !kept : want === res;
    if (kept && want !== res) wrong++;
    if (!pass) ok = false;
    lines.push(`${k} -> ${res}${pass ? '' : ` (want ${want})`}`);
  }
  for (const [p, want] of Object.entries(c.docs ?? {})) {
    const uid = b.res.docOf.get(p);
    const kept = [...docOf].find(([, u]) => u === uid)?.[0];
    const res = kept ? `keep:${kept}` : w.reg.docs[uid!]?.state === 'unresolved' ? 'unresolved' : 'new';
    if (res !== want) ok = false;
    lines.push(`doc ${p} -> ${res}`);
  }
  return { ok, wrong, lines };
}

// ── R2's synthetic cases (uid-prototype/fixtures.ts), as they were ──

const os = (name: string, reqs: Array<[string, string]>) =>
  `# ${name} Specification\n\n## Purpose\nWhat ${name} does.\n\n## Requirements\n` +
  reqs.map(([t, b]) => `### Requirement: ${t}\n${b}\n\n#### Scenario: basic\n- **WHEN** it happens\n- **THEN** it works\n`).join('\n');
const kiro = (reqs: Array<[string, string[]]>) =>
  `# Requirements Document\n\n## Introduction\nA feature.\n\n## Requirements\n\n` +
  reqs.map(([story, acs], n) => `### Requirement ${n + 1}\n\n**User Story:** ${story}\n\n#### Acceptance Criteria\n\n${acs.map((a, k) => `${k + 1}. ${a}`).join('\n')}\n`).join('\n');
const srs = (rows: Array<[string, string]>) =>
  `---\nid: SRS\ntitle: S\nversion: 0.1\nstatus: draft\nupdated: 2026-11-03\n---\n\n# SRS\n\n| ID | 요구사항 | 단계 | 출처 | 검증 |\n|---|---|---|---|---|\n` +
  rows.map(([id, t]) => `| ${id} | ${t} | 1 | 사용자 | E2E |`).join('\n') + '\n';

const LOGIN = 'The system SHALL allow a registered user to sign in with an email address and a password, and SHALL lock the account for 15 minutes after five failed attempts in a row.';
const RESET = 'The system SHALL email a single-use password reset link that expires after 30 minutes to the address on the account.';
const AUDIT = 'The system SHALL record every sign-in, sign-out and password change in an append-only audit log kept for 90 days.';
const SESS = 'The system SHALL expire an idle session after 12 hours and SHALL let the user revoke any of their sessions from the settings page.';
const K1: [string, string[]] = ['As an owner, I want to add a project from a folder, so that its agents appear in the office.', ['WHEN the owner picks a folder THEN the system SHALL register it as a project', 'WHEN the folder is not a git repository THEN the system SHALL still register it and show a warning']];
const K2: [string, string[]] = ['As an owner, I want to rename a project, so that the office shows the name I use.', ['WHEN the owner enters a new name THEN the system SHALL show it on the room sign within one second', 'IF the name is empty THEN the system SHALL keep the old name']];
const K3: [string, string[]] = ['As an owner, I want to remove a project, so that its room disappears.', ['WHEN the owner removes a project THEN the system SHALL keep its files on disk', 'WHEN a project is removed THEN the system SHALL stop its agents first']];
const K0: [string, string[]] = ['As an owner, I want to pin a project, so that it stays on the first floor.', ['WHEN the owner pins a project THEN the system SHALL move its room to floor 1']];

const R2_CASES: Case[] = [
  { name: 'F1 OpenSpec heading renamed, body kept', before: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Password reset', RESET]]) },
    after: { 'a/spec.md': os('auth', [['Sign-in with email', LOGIN], ['Password reset', RESET]]) },
    expect: { 'Requirement: Sign-in with email': 'keep:Requirement: User login', 'Requirement: Password reset': 'keep:Requirement: Password reset' } },
  { name: 'F2 OpenSpec body rewritten, title kept (same doc)', before: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Password reset', RESET], ['Audit log', AUDIT]]) },
    after: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Password reset', 'Users who forgot their secret get a recovery code by SMS; support staff can trigger it too.'], ['Audit log', AUDIT]]) },
    expect: { 'Requirement: Password reset': 'keep:Requirement: Password reset' } },
  { name: 'F3 Kiro: new Requirement 1 inserted, all renumbered, one edited', before: { 'k/requirements.md': kiro([K1, K2, K3]) },
    after: { 'k/requirements.md': kiro([K0, K1, [K2[0], [K2[1][0], 'IF the name is empty or only spaces THEN the system SHALL keep the old name']], K3]) },
    expect: { 'Requirement 1': 'new', 'Requirement 2': 'keep:Requirement 1', 'Requirement 3': 'keep:Requirement 2', 'Requirement 4': 'keep:Requirement 3' } },
  { name: 'F4 moved to another file, lightly edited', before: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Session expiry', SESS]]), 'b/spec.md': os('session', [['Audit log', AUDIT]]) },
    after: { 'a/spec.md': os('auth', [['User login', LOGIN]]), 'b/spec.md': os('session', [['Audit log', AUDIT], ['Session expiry', SESS.replace('12 hours', '8 hours') + ' Admins can change the limit.']]) },
    expect: { 'Requirement: Session expiry': 'keep:Requirement: Session expiry' } },
  { name: 'F5 moved to another file and heavily rewritten', before: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Session expiry', SESS]]), 'b/spec.md': os('session', [['Audit log', AUDIT]]) },
    after: { 'a/spec.md': os('auth', [['User login', LOGIN]]), 'b/spec.md': os('session', [['Audit log', AUDIT], ['Session expiry', 'Logged-in state ends by itself when nobody touches the app for a while; people see a list of devices and can kick one out.']]) },
    expect: { 'Requirement: Session expiry': 'notkeep' } },
  { name: 'F6 copied into a second file, original stays', before: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT]]), 'b/spec.md': os('session', [['Session expiry', SESS]]) },
    after: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT]]), 'b/spec.md': os('session', [['Session expiry', SESS], ['Audit log', AUDIT]]) },
    expect: { 'a/spec.md#Requirement: Audit log': 'keep:Requirement: Audit log', 'b/spec.md#Requirement: Audit log': 'new' } },
  { name: 'F7 original deleted, two identical copies elsewhere', before: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT]]), 'b/spec.md': os('session', [['Session expiry', SESS]]), 'c/spec.md': os('admin', [['Password reset', RESET]]) },
    after: { 'a/spec.md': os('auth', [['User login', LOGIN]]), 'b/spec.md': os('session', [['Session expiry', SESS], ['Audit log', AUDIT]]), 'c/spec.md': os('admin', [['Password reset', RESET], ['Audit log', AUDIT]]) },
    expect: { 'b/spec.md#Requirement: Audit log': 'unresolved', 'c/spec.md#Requirement: Audit log': 'unresolved' } },
  { name: 'F8 display id reused: old text renumbered (edited), new text under the old id', before: { 'r/SRS.md': srs([['FR-ABC-001', LOGIN], ['FR-ABC-002', RESET]]) },
    after: { 'r/SRS.md': srs([['FR-ABC-001', 'The office SHALL show a weather widget on the lobby wall that refreshes every ten minutes from the host clock.'], ['FR-ABC-002', RESET], ['FR-ABC-003', LOGIN + ' The lock time is configurable.']]) },
    expect: { 'FR-ABC-003': 'keep:FR-ABC-001', 'FR-ABC-001': 'notkeep' } },
  { name: 'F9 display id renumbered, text same', before: { 'r/SRS.md': srs([['FR-ABC-001', LOGIN], ['FR-ABC-002', RESET]]) },
    after: { 'r/SRS.md': srs([['FR-XYZ-004', LOGIN], ['FR-ABC-002', RESET]]) }, expect: { 'FR-XYZ-004': 'keep:FR-ABC-001' } },
  { name: 'F10 delete-marked row', before: { 'r/SRS.md': srs([['FR-ABC-001', LOGIN], ['FR-ABC-002', RESET]]) },
    after: { 'r/SRS.md': srs([['FR-ABC-001', '(삭제, v0.2) 이 규칙은 쓰지 않는다. FR-ABC-002로 대체'], ['FR-ABC-002', RESET]]) }, expect: { 'FR-ABC-001': 'keep:FR-ABC-001' } },
  { name: 'F11 same id, wholly reworded, old text nowhere (same doc)', before: { 'r/SRS.md': srs([['FR-ABC-001', LOGIN], ['FR-ABC-002', RESET]]) },
    after: { 'r/SRS.md': srs([['FR-ABC-001', '로그인은 이메일과 비밀번호로 하고, 다섯 번 틀리면 15분 잠근다.'], ['FR-ABC-002', RESET]]) }, expect: { 'FR-ABC-001': 'keep:FR-ABC-001' } },
  { name: 'F12 two requirements swap places, both lightly edited', before: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Password reset', RESET]]) },
    after: { 'a/spec.md': os('auth', [['Password reset', RESET.replace('30 minutes', '20 minutes')], ['User login', LOGIN.replace('15 minutes', '10 minutes')]]) },
    expect: { 'Requirement: Password reset': 'keep:Requirement: Password reset', 'Requirement: User login': 'keep:Requirement: User login' } },
  { name: 'F13 one requirement split into two', before: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT]]) },
    after: { 'a/spec.md': os('auth', [['User login', 'The system SHALL allow a registered user to sign in with an email address and a password.'], ['Account lock', 'The system SHALL lock the account for 15 minutes after five failed attempts in a row.'], ['Audit log', AUDIT]]) },
    expect: { 'Requirement: Account lock': 'notkeep' } },
  { name: 'F14 doc renamed without git (content same)', before: { 'a/auth.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT]]) }, renames: null,
    after: { 'specs/authentication.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT]]) },
    expect: { 'Requirement: User login': 'keep:Requirement: User login' }, docs: { 'specs/authentication.md': 'keep:a/auth.md' } },
  { name: 'F15 doc renamed with git and rewritten', before: { 'a/auth.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT]]) }, renames: { 'b/login.md': 'a/auth.md' },
    after: { 'b/login.md': os('login', [['Sign-in', LOGIN]]) }, expect: { 'Requirement: Sign-in': 'keep:Requirement: User login' }, docs: { 'b/login.md': 'keep:a/auth.md' } },
  { name: 'F16 new file at a deleted file\'s path with other content', before: { 'a/auth.md': os('auth', [['User login', LOGIN]]) },
    after: { 'a/auth.md': os('billing', [['Invoices', 'The system SHALL issue a PDF invoice each month to every paying customer with tax lines per country.']]) },
    expect: { 'Requirement: Invoices': 'new' }, docs: { 'a/auth.md': 'keep:a/auth.md' } },
];

// ── SPT 0.3's traps (the ones with no git; the service tests have the git ones) ──

const PURPOSE =
  '# Recovery Specification\n\n## Purpose\nThis document collects what the sign-in service must do for owners, guests and the help desk, how long it keeps what it learns, and which parts other teams may rely on when they build screens on top of it.\n\n## Requirements\n';
const KO_BEFORE = '비밀번호를 잊은 사람에게 한 번만 쓸 수 있는 재설정 링크를 계정의 메일 주소로 보내고, 링크는 삼십 분 뒤에 끝나며 이미 연 링크는 다시 받지 않는다. 링크를 연 기기와 시각은 계정 기록에 남기고, 같은 주소로 하루에 다섯 번 넘게 요청하면 그날은 더 보내지 않는다.';
const KO_AFTER = '상담원은 전화한 고객에게 개인 질문 두 개를 확인한 뒤 복구 번호를 읽어 줄 수 있고, 그런 통화는 담당자 이름과 시각과 함께 상담 일지에 남긴다. 일지는 매주 월요일 아침 팀장이 훑어보고 이상한 통화가 있으면 보안 담당에게 넘긴다.';
const PROSE = '겨울 빌드 출시 노트: 시작이 빨라지고, 로비 카펫이 새로 깔리고, 삼층 선풍기가 조용해졌다.\n';
const TRAPS: Case[] = [
  { name: 'P1 the same path, a completely different document', before: { 'r/SRS.md': srs([['FR-ABC-001', LOGIN], ['FR-ABC-002', RESET]]) },
    after: { 'r/SRS.md': `# 회의록\n\n## M-001 점심\n\n오늘은 점심 메뉴를 정했다. 김밥과 라면.\n\n- [ ] 다음 주 회의실 예약\n\n${PROSE}` },
    expect: {}, docs: { 'r/SRS.md': 'unresolved' } },
  { name: 'P2 identical items, neighbours match: each keeps its own', before: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT], ['Session expiry', SESS], ['Audit log', AUDIT], ['Password reset', RESET]]) },
    after: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT], ['Session expiry', SESS], ['Audit log', AUDIT], ['Password reset', RESET.replace('30', '45')]]) },
    expect: { 'Requirement: User login': 'keep:Requirement: User login', 'Requirement: Session expiry': 'keep:Requirement: Session expiry', 'Requirement: Password reset': 'keep:Requirement: Password reset' } },
  { name: 'P3 identical items, neighbours do not match: asked, never zipped by order', before: { 'a/spec.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT], ['Session expiry', SESS], ['Audit log', AUDIT]]) },
    after: { 'a/spec.md': os('auth', [['Audit log', AUDIT], ['Password reset', RESET], ['Audit log', AUDIT], ['Session expiry', SESS.replace('12', '24')]]) },
    expect: { 'Requirement: Audit log': 'unresolved' } },
  { name: 'P4 an ID-reuse chain with light edits: 001 deleted, 002 and 003 renumbered down (review fix)',
    before: { 'r/SRS.md': srs([['FR-ABC-001', LOGIN], ['FR-ABC-002', RESET], ['FR-ABC-003', AUDIT]]) },
    after: { 'r/SRS.md': srs([['FR-ABC-001', RESET.replace('30 minutes', '20 minutes')], ['FR-ABC-002', AUDIT.replace('90 days', '120 days')]]) },
    // Either the text's own UID or a question; never the deleted 001's UID on old 002's text.
    expect: { 'FR-ABC-001': 'keep:FR-ABC-002', 'FR-ABC-002': 'keep:FR-ABC-003' } },
  { name: 'A1 two documents swap paths: each UID follows its content', before: { 'a.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT]]), 'b.md': os('session', [['Session expiry', SESS], ['Password reset', RESET]]) },
    after: { 'a.md': os('session', [['Session expiry', SESS], ['Password reset', RESET]]), 'b.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT]]) },
    expect: { 'Requirement: User login': 'keep:Requirement: User login', 'Requirement: Session expiry': 'keep:Requirement: Session expiry' }, docs: { 'a.md': 'keep:b.md', 'b.md': 'keep:a.md' } },
  { name: 'A5 git renames the SRS to an archive and a new SRS takes the old path', before: { 'r/SRS.md': srs([['FR-ABC-001', LOGIN], ['FR-ABC-002', RESET]]) },
    renames: { 'archive/SRS-v1.md': 'r/SRS.md' },
    after: { 'archive/SRS-v1.md': srs([['FR-ABC-001', LOGIN], ['FR-ABC-002', RESET]]), 'r/SRS.md': srs([['FR-XYZ-001', AUDIT], ['FR-XYZ-002', SESS]]) },
    expect: { 'FR-ABC-001': 'keep:FR-ABC-001', 'FR-XYZ-001': 'new' }, docs: { 'archive/SRS-v1.md': 'keep:r/SRS.md', 'r/SRS.md': 'new' } },
  { name: 'P5 pins ACCEPT: title changed a little, body rewritten, the same document: 0.45-0.6 is a question, not a match',
    before: { 'a/spec.md': `${PURPOSE}### Requirement: Account recovery\n${KO_BEFORE}\n` },
    after: { 'a/spec.md': `${PURPOSE}### Requirement: Account recovery by phone\n${KO_AFTER}\n` },
    expect: { 'Requirement: Account recovery by phone': 'unresolved' } },
];

describe('R2 fixtures and the SPT 0.3 traps', () => {
  it.each([...R2_CASES, ...TRAPS].map((c) => [c.name, c] as const))('%s', (_, c) => {
    const r = runCase(c);
    expect(r.wrong, r.lines.join('\n')).toBe(0);
    expect(r.ok, r.lines.join('\n')).toBe(true);
  });

  it('P2: two identical items keep their own UIDs by their neighbours', () => {
    const w = world();
    const files = { 'a/spec.md': os('auth', [['User login', LOGIN], ['Audit log', AUDIT], ['Session expiry', SESS], ['Audit log', AUDIT]]) };
    const a = w.step(files);
    const b = w.step({ 'a/spec.md': files['a/spec.md'].replace('15 minutes', '20 minutes') });
    const audits = (x: typeof a) => x.items.filter((i) => i.key === 'Requirement: Audit log').map((i) => i.uid);
    expect(audits(b)).toEqual(audits(a));
    expect(b.items.every((i) => i.state === 'active')).toBe(true);
  });

  it('P3: every copy is asked, with both old records as candidates', () => {
    const r = runCase(TRAPS[2]);
    expect(r.lines.filter((l) => l.includes('unresolved'))).toHaveLength(1); // the key names one; both are checked below
    const w = world();
    w.step(TRAPS[2].before);
    const b = w.step(TRAPS[2].after);
    const asked = b.items.filter((i) => i.key === 'Requirement: Audit log');
    expect(asked.map((i) => i.state)).toEqual(['unresolved', 'unresolved']);
    expect(asked.map((i) => w.reg.items[i.uid].candidates?.length)).toEqual([2, 2]);
  });

  it('P1: the same path wholly rewritten asks "same document?" and its items wait as provisional', () => {
    const w = world();
    const a = w.step(TRAPS[0].before);
    const b = w.step(TRAPS[0].after);
    const uid = b.res.docOf.get('r/SRS.md')!;
    expect(uid).not.toBe(a.res.docOf.get('r/SRS.md'));
    expect(w.reg.docs[uid]).toMatchObject({ state: 'unresolved', candidates: [{ uid: a.res.docOf.get('r/SRS.md'), why: ['path'] }] });
    expect(b.items.map((i) => i.state)).toEqual(['unresolved']);
    expect(w.reg.docs[a.res.docOf.get('r/SRS.md')!].state).toBe('retired');
  });

  it('a short checkbox repeated, its neighbours changed: new UIDs, no question', () => {
    const w = world();
    const plan = (x: string) => `# Plan\n- [ ] 테스트\n- [ ] ${x}\n- [ ] 테스트\n`;
    const opts = { ...OPTS, kind: 'plan' as const };
    const docs = (x: string): SnapDoc[] => [{ path: 'p.md', sketch: sketchOf(plan(x), H), items: extract(plan(x), 'p.md', opts) }];
    const ctx = (d: SnapDoc[]) => ({
      docs: d, renames: null, rev: 'r', at: '', hash: H, mat: () => null, sketch: () => null,
      newDoc: () => ((w.reg.docs.d_aaaaaaaaaa = { path: 'p.md', kind: 'plan', mode: 'auto', tracked: true, state: 'active', git: 'not-git', blob: '', size: 0, mtimeMs: 0, changedAt: '', pathHistory: [], decisions: [] } as DocRecord), 'd_aaaaaaaaaa'),
      newItem: (() => { let k = 0; return () => `r_${(++k).toString().padStart(10, 'a')}${Math.random()}`; })(),
    });
    matchSnapshot(w.reg, ctx(docs('개요 탭')));
    const res = matchSnapshot(w.reg, ctx(docs('개요 탭 하나 더')));
    expect(Object.values(w.reg.items).filter((r) => r.state === 'unresolved')).toEqual([]);
    expect(res.itemsOf.get('d_aaaaaaaaaa')).toHaveLength(3);
  });

  it('A7: while two questions name X, a third copy does not take X (it is asked too)', () => {
    const w = world();
    const f7 = R2_CASES.find((c) => c.name.startsWith('F7'))!;
    const a = w.step(f7.before);
    const x = a.items.find((i) => i.key === 'Requirement: Audit log')!.uid;
    const b = w.step(f7.after);
    expect(b.items.filter((i) => i.key === 'Requirement: Audit log').map((i) => i.state)).toEqual(['unresolved', 'unresolved']);
    const c = w.step({ ...f7.after, 'd/spec.md': os('audit', [['Audit log', AUDIT.replace('90 days', '91 days')]]) });
    const copies = c.items.filter((i) => i.key === 'Requirement: Audit log');
    expect(copies.map((i) => i.uid)).not.toContain(x);
    expect(copies.map((i) => i.state)).toEqual(['unresolved', 'unresolved', 'unresolved']);
    expect(w.reg.items[x].state).toBe('retired');
    expect(copies.every((i) => w.reg.items[i.uid].candidates?.some((k) => k.uid === x))).toBe(true);
  });

  it('T2 inside a document still holds when a trace table repeats the IDs (R2, SPT §2.5)', () => {
    const w = world();
    const trace = '# 추적표\n\n| ID | 시험 |\n|---|---|\n| FR-ABC-001 | TC-1 |\n| FR-ABC-002 | TC-2 |\n';
    const a = w.step({ 'r/SRS.md': srs([['FR-ABC-001', LOGIN], ['FR-ABC-002', RESET]]), 'r/traceability.md': trace });
    const b = w.step({ 'r/SRS.md': srs([['FR-ABC-001', '로그인은 이메일과 비밀번호로 하고, 다섯 번 틀리면 15분 잠근다.'], ['FR-ABC-002', RESET]]), 'r/traceability.md': trace });
    const srsRow = (x: typeof a) => x.items.find((i) => i.key === 'FR-ABC-001' && i.path === 'r/SRS.md')!;
    expect(srsRow(b).uid).toBe(srsRow(a).uid);
    expect(w.reg.items[srsRow(b).uid].decisions.at(-1)!.how).toMatch(/^T2/);
  });

  it('F17: this repository\'s cld/docs moved to specs/ without git keeps every document and item', () => {
    const root = path.resolve(__dirname, '../../../../cld/docs');
    const files: Files = {};
    for (const rel of fs.readdirSync(root, { recursive: true }).map(String))
      if (rel.endsWith('.md')) files[`cld/docs/${rel}`] = fs.readFileSync(path.join(root, rel), 'utf-8');
    const w = world();
    const a = w.step(files, null);
    const moved = Object.fromEntries(Object.entries(files).map(([p, t]) => [p.replace('cld/docs/', 'specs/'), t]));
    const t0 = performance.now();
    const b = w.step(moved, null);
    const ms = performance.now() - t0;
    // By place: the same document, the same position.
    const place = (x: typeof a, from = 'specs/') => x.items.map((i, n) => `${i.path.replace(from, 'specs/')}#${x.items.slice(0, n).filter((j) => j.path === i.path).length}=${i.uid}`);
    const before = new Set(place(a, 'cld/docs/'));
    const kept = place(b).filter((k) => before.has(k)).length;
    const docsKept = [...b.res.docOf.values()].filter((u) => [...a.res.docOf.values()].includes(u)).length;
    console.log(`F17: docs ${docsKept}/${b.res.docOf.size}, items ${kept}/${b.items.length}, rematch ${Math.round(ms)} ms`);
    expect(docsKept).toBe(Object.keys(files).length);
    expect(kept).toBe(b.items.length);
  });
});
