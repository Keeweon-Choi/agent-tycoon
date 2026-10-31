/**
 * The code editor (A6): CodeMirror 6. Loaded only when a file is opened for editing (FileExplorer
 * lazy-imports this module), so the explorer itself stays light. It holds the text; the owner of the
 * session reads it back through `onChange`. `docKey` replaces the whole text (a reload), `marks` are
 * the 1-based lines an agent changed (the yellow lines).
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { type Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

const EDITOR_FONT = "'FS Pixel Sans', 'Galmuri11', monospace";

const setMarks = StateEffect.define<number[]>();
const agentLine = Decoration.line({ class: 'cm-agent-line' });

/** Yellow lines; they follow the text as it is edited and go away with a new set (or a reload's empty one). */
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const effect of tr.effects)
      if (effect.is(setMarks)) {
        const builder = new RangeSetBuilder<Decoration>();
        for (const n of effect.value)
          if (n >= 1 && n <= tr.state.doc.lines)
            builder.add(tr.state.doc.line(n).from, tr.state.doc.line(n).from, agentLine);
        set = builder.finish();
      }
    return set;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword],
    color: 'var(--color-code-keyword)',
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--color-code-string)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--color-code-comment)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--color-code-number)' },
  {
    tag: [tags.typeName, tags.className, tags.tagName, tags.propertyName],
    color: 'var(--color-code-type)',
  },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--color-code-bg)', color: 'var(--color-text)', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: EDITOR_FONT, lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--color-text)' },
  '.cm-cursor': { borderLeftColor: 'var(--color-text)' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-code-bg)',
    color: 'var(--color-code-num)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'var(--color-code-line-on)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-code-line-on)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
    {
      backgroundColor: 'var(--color-active-bg)',
    },
  '.cm-line': { borderLeft: '3px solid transparent', paddingLeft: '3px' },
  '.cm-agent-line': {
    backgroundColor: 'var(--color-code-agent-bg)',
    borderLeftColor: 'var(--color-code-agent)',
  },
});

function language(path: string): Extension {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext))
    return javascript({ typescript: true, jsx: ext === 'tsx' });
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return javascript({ jsx: true });
  if (ext === 'json') return json();
  if (ext === 'css') return css();
  return [];
}

export default function Editor({
  path,
  doc,
  docKey,
  marks,
  label,
  onChange,
}: {
  path: string;
  doc: string;
  docKey: number;
  marks: readonly number[];
  label: string;
  onChange: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  // The latest text and marks, read when the view is (re)built or the text is replaced.
  const latest = useRef({ doc, marks });
  latest.current = { doc, marks };

  useEffect(() => {
    const created = new EditorView({
      doc: latest.current.doc,
      parent: host.current!,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        syntaxHighlighting(highlight),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) change.current(update.state.doc.toString());
        }),
        marksField,
        theme,
        language(path),
      ],
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, [path, label]);

  // A reload (or the first text): replace the whole text, keep the marks the owner passes.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (v.state.doc.toString() !== latest.current.doc)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: latest.current.doc } });
    v.dispatch({ effects: setMarks.of([...latest.current.marks]) });
  }, [docKey]);

  useEffect(() => {
    view.current?.dispatch({ effects: setMarks.of([...marks]) });
  }, [marks]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-testid="code-editor" />;
}
