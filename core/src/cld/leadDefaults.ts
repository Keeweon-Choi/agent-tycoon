/**
 * The model and effort a new Lead gets when the person gives none (owner 10-25 22:48: a Lead added
 * with no model fell back to Claude's own global default, Haiku on that PC). The add form shows
 * them preselected and the engine applies them to an add that names neither, so every add path
 * agrees: the model and the effort most of the existing Leads use, else the most capable model the
 * installed Claude Code lists with its highest effort. An empty value the person chose stays empty.
 */

/** Model families, most capable first. ponytail: an alias outside these (a new family) ranks after
 *  them; add it here when Claude Code lists one that should win. */
const FAMILIES = ['opus', 'sonnet', 'haiku'];
const EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low'];

function mostUsed(values: Array<string | undefined>): string | undefined {
  const count = new Map<string, number>();
  for (const v of values) if (v) count.set(v, (count.get(v) ?? 0) + 1);
  let best: string | undefined;
  for (const [v, n] of count) if (best === undefined || n > count.get(best)!) best = v;
  return best;
}

export function leadDefaults(
  leads: Array<{ model?: string; effort?: string }>,
  choices?: { models: string[]; efforts: string[] },
): { model?: string; effort?: string } {
  const topModel =
    FAMILIES.map((f) => choices?.models.find((m) => m.toLowerCase().includes(f))).find(Boolean) ??
    choices?.models[0];
  const topEffort = EFFORTS.find((e) => choices?.efforts.includes(e));
  return {
    model: mostUsed(leads.map((l) => l.model)) ?? topModel,
    effort: mostUsed(leads.map((l) => l.effort)) ?? topEffort,
  };
}
