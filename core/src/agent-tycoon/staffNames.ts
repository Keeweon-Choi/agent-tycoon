/**
 * TEMP-PLATES: the names a project's temporary employees are hired under (the owner's
 * roster v1.0, 10-24 16:59), Korean and English exactly as written. Each name's id comes
 * from the original character, so a later spelling change keeps the id; an employee keeps
 * its name id, and the UI language only picks the form. Franchise titles are left out:
 * nothing the UI shows names them (char-design §8).
 *
 * `status: 'held'` (보류) rows are kept but not hired under; flipping one row's status is
 * the whole change. Counts are always derived from this list, never written down.
 */
export type StaffNameStatus = 'active' | 'held';

export interface StaffName {
  id: string;
  ko: string;
  en: string;
  status: StaffNameStatus;
}

const row = (id: string, ko: string, en: string, status: StaffNameStatus = 'active'): StaffName => ({
  id,
  ko,
  en,
  status,
});

export const STAFF_NAMES: readonly StaffName[] = [
  row('harry-potter', '해리 커밋터', 'Harry Committer'),
  row('hermione-granger', '에러미온느 그레인지러', 'Errmione Grangerror'),
  row('ron-weasley', '론 리베이즐리', 'Ron Rebasley'),
  row('draco-malfoy', '드레이코 말포맷', 'Draco Malformat'),
  row('severus-snape', '세베루스 스냅샷', 'Severus Snapshot'),
  row('minerva-mcgonagall', '미네르바 맥고나깃', 'Minerva McGonagit'),
  row('luna-lovegood', '루나 로그굿', 'Luna Loggood'),
  row('neville-longbottom', '네빌 롱버퍼', 'Neville Longbuffer'),
  row('rubeus-hagrid', '루베우스 해시그리드', 'Rubeus Hashgrid'),
  row('luke-skywalker', '루크 스택워커', 'Luke Stackwalker'),
  row('leia-organa', '레아 오거나이저', 'Leia Organizer'),
  row('darth-vader', '다스 디버거', 'Darth Debugger'),
  row('han-solo', '한 솔로스레드', 'Han Solothread'),
  row('obi-wan-kenobi', '오비완 커넥토비', 'Obi-Wan Connectobi'),
  row('frodo-baggins', '프로도 배포긴스', 'Frodo Deploygins'),
  row('gandalf-the-grey', '간달프 더 그레이들', 'Gandalf the Gradle'),
  row('aragorn', '어레이곤', 'Arraygorn'),
  row('samwise-gamgee', '샘와이즈 깃지', 'Samwise Gitgee'),
  row('legolas-greenleaf', '레골라스 그린리프레시', 'Legolas Greenrefresh'),
  row('gimli', '깃리', 'Gitli'),
  row('smeagol', '스키마골', 'Schemagol'),
  row('boromir', '보로머지', 'Boromerge'),
  row('meriadoc-brandybuck', '메리아독 브랜치벅', 'Meriadoc Branchybuck'),
  row('peregrin-took', '페레그린 툴킷', 'Peregrin Toolkit'),
  row('tony-stark', '토니 스택', 'Tony Stack'),
  row('steve-rogers', '스티브 로거스', 'Steve Loggers'),
  row('natasha-romanoff', '나타샤 로깅오프', 'Natasha Loggingoff'),
  row('thor-odinson', '토르 오딘싱크', 'Thor Odinsync'),
  row('bruce-banner', '브루스 버그너', 'Bruce Bugner'),
  row('clint-barton', '클린트 버튼', 'Clint Button'),
  row('loki-laufeyson', '로키 로그페이슨', 'Loki Logfeyson'),
  row('peter-parker', '피터 파커밋', 'Peter Parcommit'),
  row('wanda-maximoff', '완다 맥시멈오프', 'Wanda Maximumoff'),
  row('nick-fury', '닉 퓨처', 'Nick Future'),
  row('joker', '조커널', 'Jokernel'),
  row('barry-allen', '배리 얼라인', 'Barry Align', 'held'),
  row('arthur-curry', '아서 쿼리', 'Arthur Query'),
  row('alfred-pennyworth', '알프레드 페니워크', 'Alfred Pennywork'),
  row('hal-jordan', '할 조인던', 'Hal JoinDone', 'held'),
  row('pikachu', '피커츄', 'Pickerchu'),
  row('eevee', '이브이벤트', 'Eeveevent'),
  row('snorlax', '잠만보틀넥', 'Snorbottleneck'),
  row('mew', '뮤우텍스', 'Mewutex'),
  row('squirtle', '꼬부깃', 'SquirtGit'),
  row('monkey-d-luffy', '몽키 D. 루프', 'Monkey D. Loop'),
  row('roronoa-zoro', '롤로노아 제로데이', 'Roronoa Zero-day'),
  row('nami', '나미그레이션', 'Namigration'),
  row('nico-robin', '니코 로깅', 'Nico Logging'),
  row('franky', '프레임키', 'Frameky'),
  row('uzumaki-naruto', '루프마키 나루토큰', 'Loopmaki Narutoken'),
  row('uchiha-sasuke', '우치하 사스케줄', 'Uchiha Saschedule'),
  row('hatake-kakashi', '하타케 캐캐시', 'Hatake Cacache'),
  row('nara-shikamaru', '나라 시카마루틴', 'Nara Shikamaroutine'),
  row('hyuga-hinata', '휴우가 히나타임아웃', 'Hyuge Hinatimeout'),
  row('jiraiya', '지라~이야', 'Jira~iya'),
  row('son-goku', '손오버클럭', 'Son Overclock'),
  row('vegeta', '베지터미널', 'Vegeterminal'),
  row('bulma-briefs', '부르마 브리프스택', 'Bulma Briefstack'),
  row('frieza', '프리즈어', 'Freeza'),
  row('majin-buu', '마인 버그', 'Majin Bug'),
];

/** The names a new employee may be hired under, in the list's order. */
export const ACTIVE_STAFF_NAMES: readonly StaffName[] = STAFF_NAMES.filter((n) => n.status === 'active');

const byId = new Map(STAFF_NAMES.map((n) => [n.id, n]));

/**
 * A name id with its repeat number: `harry-potter`, or `harry-potter#2` once every active
 * name is taken in the project (the numbered fallback, shown "해리 커밋터 2").
 */
export function splitNameId(nameId: string): { base: string; n: number | null } {
  const m = /^(.*)#(\d+)$/.exec(nameId);
  return m ? { base: m[1], n: Number(m[2]) } : { base: nameId, n: null };
}

/**
 * The shown name in `lang`. A held or otherwise inactive row still names an employee who
 * already has it; an id this list does not know (an older daemon's) is shown as it is.
 */
export function staffName(nameId: string, lang: 'ko' | 'en'): string {
  const { base, n } = splitNameId(nameId);
  const name = byId.get(base);
  if (!name) return nameId;
  return n === null ? name[lang] : `${name[lang]} ${n}`;
}
