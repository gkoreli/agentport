import { mountPanel, type SiteTool } from './agentport-ui.js';

/**
 * A second surface, for the only reason that matters: the *same* agent, with
 * the same memory and the same subscription, attaches here too — and gets a
 * completely different set of hands. Nothing about the agent changed. Only
 * the grant did.
 */

type Column = 'todo' | 'doing' | 'done';
interface Task {
  id: string;
  title: string;
  column: Column;
}

const COLUMNS: { key: Column; label: string }[] = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'In progress' },
  { key: 'done', label: 'Done' },
];

let nextId = 4;
const tasks: Task[] = [
  { id: 't1', title: 'Draft the launch post', column: 'todo' },
  { id: 't2', title: 'Wire up the relay', column: 'doing' },
  { id: 't3', title: 'Pick a name', column: 'done' },
];

const board = document.getElementById('board') as HTMLElement;

function render(): void {
  board.innerHTML = COLUMNS.map(
    (column) => `<div class="col"><h2>${column.label}</h2>${tasks
      .filter((task) => task.column === column.key)
      .map((task) => `<div class="task">${task.title}<small>${task.id}</small></div>`)
      .join('')}</div>`,
  ).join('');
}
render();

const find = (id: string): Task => {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};

const tools: SiteTool[] = [
  {
    name: 'tasker.board.read',
    description: 'Read every task on the board with its column',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ tasks, columns: COLUMNS.map((column) => column.key) }),
  },
  {
    name: 'tasker.task.create',
    description: 'Create a task in a column',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        column: { type: 'string', enum: ['todo', 'doing', 'done'] },
      },
      required: ['title'],
    },
    handler: (args) => {
      const task: Task = {
        id: `t${nextId++}`,
        title: String(args.title ?? 'Untitled'),
        column: (args.column as Column) ?? 'todo',
      };
      tasks.push(task);
      render();
      return task;
    },
  },
  {
    name: 'tasker.task.move',
    description: 'Move a task to a different column',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        column: { type: 'string', enum: ['todo', 'doing', 'done'] },
      },
      required: ['id', 'column'],
    },
    handler: (args) => {
      const task = find(String(args.id));
      task.column = args.column as Column;
      render();
      return task;
    },
  },
  {
    name: 'tasker.task.delete',
    description: 'Delete a task permanently',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    // Irreversible from the user's point of view, so it is never automatic.
    requiresApproval: true,
    handler: (args) => {
      const index = tasks.findIndex((task) => task.id === String(args.id));
      if (index < 0) throw new Error(`no task ${String(args.id)}`);
      const [removed] = tasks.splice(index, 1);
      render();
      return { deleted: removed };
    },
  },
];

void mountPanel(document.getElementById('agent-panel') as HTMLElement, {
  name: 'Tasker',
  route: '/boards/sprint',
  context: { boardId: 'sprint' },
  tools,
  alwaysAsk: ['tasker.task.delete'],
  placeholder: 'Ask your agent to plan…',
  suggestions: ['break the launch post into subtasks', 'what should I do next?'],
});
