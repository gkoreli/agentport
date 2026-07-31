import { mountPanel, type SiteTool } from './agentport-ui.js';

const editor = document.getElementById('editor') as HTMLTextAreaElement;

/**
 * Inkwell's tools. Note what is NOT here: no model, no key, no prompt, no
 * conversation state. A surface describes what may be done to it and stops.
 */
const tools: SiteTool[] = [
  {
    name: 'inkwell.document.read',
    description: 'Read the current document',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ documentId: 'doc_123', text: editor.value }),
  },
  {
    name: 'inkwell.document.getSelection',
    description: 'Read the text the user has selected',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({
      text: editor.value.slice(editor.selectionStart, editor.selectionEnd),
      start: editor.selectionStart,
      end: editor.selectionEnd,
    }),
  },
  {
    name: 'inkwell.document.append',
    description: 'Append a paragraph to the end of the document',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The paragraph to append' } },
      required: ['text'],
    },
    handler: (args) => {
      editor.value = `${editor.value.trimEnd()}\n\n${String(args.text ?? '')}`;
      return { ok: true, length: editor.value.length };
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
    // Destructive: never runs without the user saying yes to this exact call.
    requiresApproval: true,
    handler: (args) => {
      const text = String(args.text ?? '');
      const { selectionStart: start, selectionEnd: end } = editor;
      editor.value = start === end ? text : editor.value.slice(0, start) + text + editor.value.slice(end);
      return { ok: true, length: editor.value.length };
    },
  },
];

void mountPanel(document.getElementById('agent-panel') as HTMLElement, {
  name: 'Inkwell',
  route: '/documents/doc_123',
  context: { documentId: 'doc_123', title: 'Draft' },
  tools,
  alwaysAsk: ['inkwell.document.replaceSelection'],
  placeholder: 'Ask your agent to write…',
  suggestions: ['continue the story', 'tighten the opening'],
});
