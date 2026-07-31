/**
 * Inkwell — co-writing a markdown document with your own agent.
 *
 * The editor is CodeMirror 6 with markdown mode. On top of it, ANNOTATIONS:
 * select a passage, attach an instruction ("tighten this", "add a source",
 * "this claim is wrong"), and send the batch to your agent. Each annotation is
 * a position-mapped range — CodeMirror keeps it pinned to the text as either
 * of you edits around it.
 *
 * The trust story is unchanged from the textarea version. The surface
 * describes what may be done to it and stops: no model, no key, no
 * conversation state. The agent reads and writes ONLY through the granted
 * tools, precise writes require approval, and the instructions the agent
 * follows are the user's annotations — document text stays data.
 */

import { EditorView, keymap, lineNumbers, highlightActiveLine, Decoration, type DecorationSet } from '@codemirror/view';
import { EditorState, StateEffect, StateField, type ChangeDesc } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { mountPanel, type PanelApi, type SiteTool } from './agentport-ui.js';

// ── Annotations ──────────────────────────────────────────────────────

interface Note {
  id: string;
  from: number;
  to: number;
  note: string;
}

const notes: Note[] = [];
let noteSeq = 0;
let panel: PanelApi | null = null;

const addMark = StateEffect.define<{ id: string; from: number; to: number }>();
const dropMark = StateEffect.define<string>();

const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(addMark)) {
        const { id, from, to } = effect.value;
        if (from < to) {
          next = next.update({
            add: [Decoration.mark({ class: 'ink-note', attributes: { 'data-note': id } }).range(from, to)],
          });
        }
      } else if (effect.is(dropMark)) {
        const id = effect.value;
        next = next.update({ filter: (_f, _t, deco) => deco.spec['attributes']?.['data-note'] !== id });
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Keep the note list's positions in lockstep with the decoration set. */
function mapNotes(changes: ChangeDesc): void {
  for (const note of notes) {
    note.from = changes.mapPos(note.from, 1);
    note.to = changes.mapPos(note.to, -1);
  }
  // A fully deleted range means the passage is gone; the note goes with it.
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i]!;
    if (note.from >= note.to) {
      notes.splice(i, 1);
      view.dispatch({ effects: dropMark.of(note.id) });
    }
  }
  renderNotes();
}

// ── Editor ───────────────────────────────────────────────────────────

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'var(--text)', fontSize: '15px', height: '100%' },
    '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.7', padding: '18px 0' },
    '.cm-line': { padding: '0 18px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#3d4654', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(124, 156, 255, .05)' },
    '.cm-selectionBackground': { backgroundColor: 'rgba(124, 156, 255, .22) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--text)' },
  },
  { dark: true },
);

const seed = `# The Calm Sea

The sea was calm that morning, which everyone later agreed was the
strangest part.

Boats that should have pitched sat perfectly still, as if the water had
decided to hold its breath. The harbourmaster logged it at 06:14 and
poured a second coffee.

## What the records show

Old logs mention a morning like it once before, in 1911 — the entry is
two lines long and ends mid-sentence.
`;

const view = new EditorView({
  parent: document.getElementById('editor') as HTMLElement,
  state: EditorState.create({
    doc: seed,
    extensions: [
      lineNumbers(),
      history(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      theme,
      markField,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) mapNotes(update.changes);
        if (update.selectionSet || update.docChanged) placeAnnotateButton();
      }),
    ],
  }),
});

// ── Annotate affordance ──────────────────────────────────────────────

const annotateBtn = document.getElementById('annotate-btn') as HTMLButtonElement;
const noteList = document.getElementById('note-list') as HTMLElement;
const noteCount = document.getElementById('note-count') as HTMLElement;
const sendNotes = document.getElementById('send-notes') as HTMLButtonElement;
const noteHint = document.getElementById('note-hint') as HTMLElement;

function placeAnnotateButton(): void {
  const { from, to } = view.state.selection.main;
  if (from === to) {
    annotateBtn.hidden = true;
    return;
  }
  const coords = view.coordsAtPos(to);
  const host = (document.getElementById('editor') as HTMLElement).getBoundingClientRect();
  if (!coords) {
    annotateBtn.hidden = true;
    return;
  }
  annotateBtn.hidden = false;
  annotateBtn.style.top = `${coords.bottom - host.top + 6}px`;
  annotateBtn.style.left = `${Math.min(coords.left - host.left, host.width - 110)}px`;
}

// The button is placed from viewport coords at selection time; any scroll
// invalidates them. scroll does not bubble, but it does capture.
(document.querySelector('.editor-wrap') as HTMLElement).addEventListener(
  'scroll',
  () => {
    annotateBtn.hidden = true;
  },
  true,
);

annotateBtn.addEventListener('mousedown', (event) => {
  // mousedown, not click: a click would first collapse the selection.
  event.preventDefault();
  const { from, to } = view.state.selection.main;
  if (from === to) return;
  const note = window.prompt('Instruction for your agent about this passage:');
  if (!note || !note.trim()) return;
  const id = `n${++noteSeq}`;
  notes.push({ id, from, to, note: note.trim() });
  view.dispatch({ effects: addMark.of({ id, from, to }), selection: { anchor: to } });
  renderNotes();
});

function excerpt(from: number, to: number, limit = 70): string {
  const text = view.state.sliceDoc(from, to).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function renderNotes(): void {
  noteCount.textContent = String(notes.length);
  sendNotes.hidden = notes.length === 0;
  noteHint.hidden = notes.length !== 0;
  noteList.replaceChildren(
    ...notes.map((note) => {
      const row = document.createElement('div');
      row.className = 'note-row';

      const quote = document.createElement('span');
      quote.className = 'note-quote';
      quote.textContent = `“${excerpt(note.from, note.to)}”`;

      const instruction = document.createElement('span');
      instruction.className = 'note-text';
      instruction.textContent = note.note;

      const remove = document.createElement('button');
      remove.className = 'note-remove';
      remove.textContent = '✕';
      remove.title = 'Remove annotation';
      remove.addEventListener('click', () => resolveNote(note.id));

      row.addEventListener('mouseenter', () => {
        view.dispatch({ selection: { anchor: note.from, head: note.to }, scrollIntoView: true });
      });

      row.append(quote, instruction, remove);
      return row;
    }),
  );
}

function resolveNote(id: string): boolean {
  const index = notes.findIndex((note) => note.id === id);
  if (index === -1) return false;
  notes.splice(index, 1);
  view.dispatch({ effects: dropMark.of(id) });
  renderNotes();
  return true;
}

/** The prompt the panel sends: the user's instructions, with exact ranges. */
function composePrompt(): string {
  const lines = notes.map(
    (note, i) =>
      `${i + 1}. [${note.id}] chars ${note.from}–${note.to}, ` +
      `"${view.state.sliceDoc(note.from, note.to).slice(0, 200)}": ${note.note}`,
  );
  return (
    `Please address my ${notes.length === 1 ? 'annotation' : 'annotations'} on the document. ` +
    `Read it with inkwell.document.read (it includes current annotation ranges), make each edit with ` +
    `inkwell.document.replaceRange, and mark each one done with inkwell.annotation.resolve.\n\n` +
    lines.join('\n')
  );
}

sendNotes.addEventListener('click', () => {
  if (notes.length === 0) return;
  if (!panel?.live) {
    noteHint.hidden = false;
    noteHint.textContent = 'Connect your agent first — then send.';
    return;
  }
  panel.send(composePrompt());
});

// ── Tools — what the agent may do to this surface ────────────────────

const doc = () => view.state.doc.toString();

const tools: SiteTool[] = [
  {
    name: 'inkwell.document.read',
    description: 'Read the current markdown document and any open annotations (id, character range, instruction)',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({
      documentId: 'doc_123',
      text: doc(),
      annotations: notes.map(({ id, from, to, note }) => ({
        id,
        from,
        to,
        excerpt: view.state.sliceDoc(from, to),
        instruction: note,
      })),
    }),
  },
  {
    name: 'inkwell.document.getSelection',
    description: 'Read the text the user has selected',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const { from, to } = view.state.selection.main;
      return { text: view.state.sliceDoc(from, to), start: from, end: to };
    },
  },
  {
    name: 'inkwell.document.append',
    description: 'Append a markdown block to the end of the document',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The markdown to append' } },
      required: ['text'],
    },
    handler: (args) => {
      const text = `\n\n${String(args['text'] ?? '').trim()}\n`;
      view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
      return { ok: true, length: view.state.doc.length };
    },
  },
  {
    name: 'inkwell.document.replaceRange',
    description:
      'Replace the characters between from and to with new text. Use the ranges from inkwell.document.read — they stay current as the document changes.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'number', description: 'Start character offset' },
        to: { type: 'number', description: 'End character offset' },
        text: { type: 'string', description: 'Replacement markdown' },
      },
      required: ['from', 'to', 'text'],
    },
    // Destructive: never runs without the user saying yes to this exact call.
    requiresApproval: true,
    handler: (args) => {
      const from = Math.max(0, Math.min(Number(args['from'] ?? 0), view.state.doc.length));
      const to = Math.max(from, Math.min(Number(args['to'] ?? from), view.state.doc.length));
      view.dispatch({ changes: { from, to, insert: String(args['text'] ?? '') } });
      return { ok: true, length: view.state.doc.length };
    },
  },
  {
    name: 'inkwell.document.replaceSelection',
    description: 'Replace the selected text, or the whole document if nothing is selected',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Replacement text' } },
      required: ['text'],
    },
    requiresApproval: true,
    handler: (args) => {
      const text = String(args['text'] ?? '');
      const { from, to } = view.state.selection.main;
      if (from === to) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      else view.dispatch({ changes: { from, to, insert: text } });
      return { ok: true, length: view.state.doc.length };
    },
  },
  {
    name: 'inkwell.annotation.resolve',
    description: 'Mark one annotation as addressed, by id. Removes its highlight for the user.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The annotation id, e.g. n3' } },
      required: ['id'],
    },
    handler: (args) => ({ ok: resolveNote(String(args['id'] ?? '')) }),
  },
];

mountPanel(document.getElementById('agent-panel') as HTMLElement, {
  name: 'Inkwell',
  route: '/documents/doc_123',
  context: { documentId: 'doc_123', title: 'The Calm Sea' },
  tools,
  alwaysAsk: ['inkwell.document.replaceRange', 'inkwell.document.replaceSelection'],
  placeholder: 'Ask your agent to write…',
  suggestions: ['continue the story', 'tighten the opening'],
  bind: (api) => {
    panel = api;
  },
});
