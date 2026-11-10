import { CLI_NAME } from './cliName.js';

/** The name in front of the engine's own message labels: `[agty · beta에게서 · 10-22 11:57]`, `[agty codex] ...`. */
export const LABEL = CLI_NAME;
/** T-80: the name those labels carried before the rename. Old transcripts, inbox and queue files, and
 *  sessions started before the update still hold it, so readers accept both. Drop this one release later. */
export const LABEL_OLD = 'cld-gui';
/** A regex source matching either name. */
export const LABEL_ANY = `(?:${LABEL}|${LABEL_OLD})`;
/** `prefix` as the labels write it now and as they wrote it before (for startsWith checks). */
export const labelPrefixes = (rest: string): string[] => [`[${LABEL}${rest}`, `[${LABEL_OLD}${rest}`];
