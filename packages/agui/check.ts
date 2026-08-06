import assert from 'node:assert/strict';

import { EventSchemas, EventType, type ToolCallEndEvent, type ToolCallResultEvent, type ToolCallStartEvent } from '@ag-ui/core';
import { AgentSession } from '@agentport/client';

import { aguiStream, onAguiEvent, type AguiEvent } from './src/index.js';

/**
 * Conformance, not just shape: every event the adapter emits is parsed by the
 * spec's own runtime schema, so drift from AG-UI fails here instead of in
 * someone else's renderer.
 */
function validate(event: AguiEvent, origin: string): void {
  const parsed = EventSchemas.safeParse(event);
  if (parsed.success) return;
  assert.fail(`${origin} emitted an invalid AG-UI ${String(event.type)}: ${JSON.stringify(parsed.error.issues)}`);
}

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
const unsubscribe = onAguiEvent(session, (event) => {
  validate(event, 'onAguiEvent');
  subscribedEvents.push(event);
});
const collecting = (async () => {
  for await (const event of adapter.events) {
    validate(event, 'aguiStream');
    streamEvents.push(event);
  }
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
// A failed call is still a result: it must reach TOOL_CALL_RESULT, not RUN_ERROR.
await session.handle({
  t: 'tool.call',
  s: session.id,
  id: 'wire-tool-2',
  name: 'notes.delete',
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
  streamEvents.map((event) => (event.type === 'CUSTOM' ? `${event.type}:${event.name}` : String(event.type))),
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
    'TOOL_CALL_RESULT',
    'TOOL_CALL_START',
    'TOOL_CALL_ARGS',
    'TOOL_CALL_END',
    'TOOL_CALL_RESULT',
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

const toolStarts = streamEvents.filter((event): event is ToolCallStartEvent => event.type === EventType.TOOL_CALL_START);
const toolEnds = streamEvents.filter((event): event is ToolCallEndEvent => event.type === EventType.TOOL_CALL_END);
const toolResults = streamEvents.filter((event): event is ToolCallResultEvent => event.type === EventType.TOOL_CALL_RESULT);
assert.equal(toolStarts.length, 2);
assert.equal(toolEnds.length, 2);
// The regression this exists to catch: a tool call that renders without its
// result. Every call must produce a TOOL_CALL_RESULT carrying what came back.
assert.equal(toolResults.length, 2);

const [okStart, failedStart] = toolStarts;
const [okEnd] = toolEnds;
const [okResult, failedResult] = toolResults;
assert.ok(okStart && failedStart && okEnd && okResult && failedResult);

assert.equal(okResult.toolCallId, okStart.toolCallId);
assert.equal(okResult.content, JSON.stringify({ saved: 'demo' }, null, 2));
assert.equal(okResult.role, 'tool');
assert.equal(typeof okResult.messageId, 'string');
assert.notEqual(okResult.messageId, okResult.toolCallId);
// The AgentPort outcome stays on rawEvent because AG-UI has no success flag on
// a tool result; the panel reads `ok` from here to style a failure.
assert.deepEqual(okResult.rawEvent, {
  name: 'notes.save',
  arguments: { title: 'demo' },
  ok: true,
  result: { saved: 'demo' },
});
// TOOL_CALL_END carries no payload of its own any more.
assert.deepEqual(Object.keys(okEnd).sort(), ['toolCallId', 'type']);

assert.equal(failedResult.toolCallId, failedStart.toolCallId);
assert.equal(failedResult.content, 'unknown tool');
assert.equal((failedResult.rawEvent as { ok: boolean }).ok, false);
assert.ok(!streamEvents.some((event) => event.type === EventType.RUN_ERROR && event.message === 'unknown tool'));

const approval = streamEvents.find(
  (event): event is Extract<AguiEvent, { type: 'CUSTOM'; name: 'agentport.approval' }> =>
    event.type === 'CUSTOM' && event.name === 'agentport.approval',
);
assert.equal(approval?.value.granted, true);
assert.ok(!streamEvents.some((event) => event.type === 'CUSTOM' && event.name === ('agentport.verify' as string)));
assert.ok(subscribedEvents.some((event) => event.type === 'RUN_STARTED'));
assert.ok(subscribedEvents.some((event) => event.type === 'RUN_ERROR'));
assert.ok(subscribedEvents.some((event) => event.type === EventType.TOOL_CALL_RESULT));

console.log(`@agentport/agui check passed (${streamEvents.length} streamed events, all valid against @ag-ui/core)`);
