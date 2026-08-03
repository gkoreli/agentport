import assert from 'node:assert/strict';

import { AgentSession } from '@agentport/client';

import { aguiStream, onAguiEvent, type AguiEvent } from './src/index.js';

const sent: unknown[] = [];
const tool = {
  name: 'notes.save',
  description: 'Save a note',
  inputSchema: { type: 'object' },
  handler: async (args: Record<string, unknown>) => ({ saved: args.title }),
};

const session = new AgentSession({
  id: 'session-check',
  surface: { name: 'AG-UI check', origin: 'https://example.test' },
  grant: { tools: [tool], alwaysAsk: [], expiresAt: Date.now() + 60_000 },
  info: { agentName: 'Fake agent', runtime: 'fake', verify: 'coral-anvil-fern-river-slate-owl' },
  tools: [tool],
  decide: async () => true,
  send: (frame) => sent.push(frame),
});

function lastPromptId(): string {
  for (let index = sent.length - 1; index >= 0; index -= 1) {
    const frame = sent[index];
    if (typeof frame === 'object' && frame !== null && 't' in frame && frame.t === 'prompt' && 'id' in frame) {
      assert.equal(typeof frame.id, 'string');
      return frame.id;
    }
  }
  throw new Error('prompt frame was not sent');
}

const adapter = aguiStream(session);
const streamEvents: AguiEvent[] = [];
const subscribedEvents: AguiEvent[] = [];
const unsubscribe = onAguiEvent(session, (event) => subscribedEvents.push(event));
const collecting = (async () => {
  for await (const event of adapter.events) streamEvents.push(event);
})();

const successfulRun = adapter.run('save this');
const firstPrompt = lastPromptId();
assert.match(firstPrompt, /^p_[0-9a-f]{24}$/);
assert.throws(() => session.startPrompt('duplicate', undefined, firstPrompt), /already active/);
assert.throws(() => session.startPrompt('malformed', undefined, 'page-chosen-id'), /invalid prompt id/);
await Promise.resolve();
const firstRun = streamEvents.find((event): event is Extract<AguiEvent, { type: 'RUN_STARTED' }> => event.type === 'RUN_STARTED');
assert.ok(firstRun);
assert.equal(adapter.cancel(firstRun.runId), true);
assert.ok(sent.some((frame) =>
  typeof frame === 'object' && frame !== null && 't' in frame && frame.t === 'prompt.cancel' &&
  'id' in frame && frame.id === firstPrompt,
));
await session.handle({ t: 'thought', s: session.id, promptId: firstPrompt, text: 'Checking the note' });
await session.handle({ t: 'delta', s: session.id, promptId: firstPrompt, text: 'Saved ' });
await session.handle({ t: 'delta', s: session.id, promptId: firstPrompt, text: 'it.' });
await session.handle({
  t: 'tool.call',
  s: session.id,
  id: 'wire-tool-1',
  name: 'notes.save',
  arguments: { title: 'demo' },
});
await session.handle({
  t: 'approval.request',
  s: session.id,
  id: 'approval-1',
  summary: 'Continue?',
});
await session.handle({ t: 'done', s: session.id, promptId: firstPrompt, stopReason: 'end_turn' });
assert.equal(await successfulRun, 'Saved it.');

const errorRun = adapter.run('fail this');
const secondPrompt = lastPromptId();
await session.handle({
  t: 'done',
  s: session.id,
  promptId: secondPrompt,
  stopReason: 'error',
  error: 'fake failure',
});
await assert.rejects(errorRun, /fake failure/);

session.close('check_complete');
await collecting;
unsubscribe();

assert.deepEqual(
  streamEvents.map((event) => (event.type === 'CUSTOM' ? `${event.type}:${event.name}` : event.type)),
  [
    'RUN_STARTED',
    'REASONING_START',
    'REASONING_MESSAGE_START',
    'REASONING_MESSAGE_CONTENT',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_CONTENT',
    'TOOL_CALL_START',
    'TOOL_CALL_ARGS',
    'TOOL_CALL_END',
    'CUSTOM:agentport.approval',
    'TEXT_MESSAGE_END',
    'REASONING_MESSAGE_END',
    'REASONING_END',
    'RUN_FINISHED',
    'RUN_STARTED',
    'RUN_ERROR',
    'CUSTOM:agentport.closed',
  ],
);

const text = streamEvents.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT');
assert.deepEqual(text.map((event) => event.delta), ['Saved ', 'it.']);
assert.ok(text.every((event) => event.messageId === firstPrompt));

const toolEnd = streamEvents.find((event) => event.type === 'TOOL_CALL_END');
assert.deepEqual(toolEnd?.rawEvent, {
  name: 'notes.save',
  arguments: { title: 'demo' },
  ok: true,
  result: { saved: 'demo' },
});

const approval = streamEvents.find(
  (event): event is Extract<AguiEvent, { type: 'CUSTOM'; name: 'agentport.approval' }> =>
    event.type === 'CUSTOM' && event.name === 'agentport.approval',
);
assert.equal(approval?.value.granted, true);
assert.ok(!streamEvents.some((event) => event.type === 'CUSTOM' && event.name === ('agentport.verify' as string)));
assert.ok(subscribedEvents.some((event) => event.type === 'RUN_STARTED'));
assert.ok(subscribedEvents.some((event) => event.type === 'RUN_ERROR'));

console.log(`@agentport/agui check passed (${streamEvents.length} streamed events)`);
