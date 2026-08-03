import type { SiteTool } from '../packages/client/src/index.js';
import { createWebMcpHarvester } from '../site/src/webmcp.js';

interface FakeModelContext {
  provideContext(context: { tools?: unknown }): void;
  registerTool(tool: unknown): { unregister(): void };
}

function fakeModelContext(): FakeModelContext {
  return {
    provideContext() {},
    registerTool() {
      return { unregister() {} };
    },
  };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

console.log('1. document.modelContext');
const documentContext = fakeModelContext();
const ignoredNavigatorContext = fakeModelContext();
const documentHarvester = createWebMcpHarvester({
  document: { modelContext: documentContext },
  navigator: { modelContext: ignoredNavigatorContext },
});
ignoredNavigatorContext.registerTool({
  name: 'navigator.ignored',
  execute: () => 'wrong spelling',
});
documentContext.provideContext({
  tools: [
    {
      name: 'document.read',
      description: 'Read the document',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: () => ({ text: 'hello' }),
    },
    {
      name: 'document.delete',
      description: 'Delete the document',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      annotations: { destructiveHint: true },
      execute: (args: Record<string, unknown>) => ({ deleted: args['id'] }),
    },
  ],
});

const harvested = documentHarvester.harvest();
check('harvests both registered tools', harvested.length === 2, harvested.map((tool) => tool.name));
check('prefers document over navigator', !harvested.some((tool) => tool.name === 'navigator.ignored'));
check('maps definition fields', harvested[0]?.description === 'Read the document', harvested[0]);
check('gates an explicit destructiveHint', harvested[1]?.requiresApproval === true, harvested[1]);
check('does not gate an unannotated/read-only tool', harvested[0]?.requiresApproval !== true, harvested[0]);
const deleteResult = await harvested[1]?.handler({ id: 'doc-7' });
check('execute() round-trips through handler', (deleteResult as { deleted?: unknown })?.deleted === 'doc-7', deleteResult);

console.log('\n2. explicit collision');
const explicit: SiteTool = {
  name: 'document.read',
  description: 'Explicit read',
  inputSchema: { type: 'object' },
  handler: () => ({ text: 'explicit' }),
};
const merged = documentHarvester.harvest([explicit]);
const mergedRead = merged.find((tool) => tool.name === 'document.read');
check('explicit tool wins on name collision', mergedRead === explicit, mergedRead);
check('collision leaves one tool with that name', merged.filter((tool) => tool.name === 'document.read').length === 1);

console.log('\n3. navigator.modelContext fallback');
const navigatorContext = fakeModelContext();
const navigatorHarvester = createWebMcpHarvester({ navigator: { modelContext: navigatorContext } });
navigatorContext.registerTool({
  name: 'legacy.update',
  description: 'Legacy update',
  inputSchema: { type: 'object' },
  execute: () => 'legacy-result',
});
const fallback = navigatorHarvester.harvest();
check('uses navigator when document.modelContext is absent', fallback[0]?.name === 'legacy.update', fallback);
check('does not gate a write-sounding name without an annotation', fallback[0]?.requiresApproval !== true, fallback[0]);
check('fallback execute() round-trips', await fallback[0]?.handler({}) === 'legacy-result');

console.log(failures === 0 ? '\nWebMCP harvest passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
