/**
 * The growth theme (public-mvp THEMES, 10-24): the counting (피로도, 휴식, 환생) is one system;
 * what a theme changes is how it looks and reads. The MVP ships Office Fantasy only.
 */
export const THEMES = {
  officeFantasy: {
    /** REST-ANIM: the drink a character takes at each 휴식 (props.json `rest`). */
    rest: { prop: 'coffee', legend: 'activity.restMoment.coffee' },
    /**
     * RANK-LEVELS: the rank follows the level: each rank starts at level `from` and runs to the
     * next one's. The last (101+) is the top; 사장 is the owner, never a rank. `star`: the icon
     * wears a small star. Names: i18n `rank.<id>`.
     */
    ranks: [
      { id: 'intern', from: 1 },
      { id: 'staff', from: 11 },
      { id: 'senior', from: 21 },
      { id: 'assistant', from: 31 },
      { id: 'manager', from: 41 },
      { id: 'deputy', from: 51 },
      { id: 'general', from: 61 },
      { id: 'director', from: 71, star: true },
      { id: 'managing', from: 81, star: true },
      { id: 'seniorManaging', from: 91, star: true },
      { id: 'vicePresident', from: 101, star: true },
    ],
  },
} as const satisfies Record<
  string,
  {
    rest: { prop: 'coffee' | 'energy'; legend: string };
    ranks: readonly { id: string; from: number; star?: true }[];
  }
>;

export const THEME = THEMES.officeFantasy;
