import type { AgentProvider, AgentSessionHandle } from '@agentport/client';
import type { InjectedProvider, PageSessionInstance } from './inpage.js';

/** Produces a readable constraint error at the exact page/client seam. */
type AssertAssignable<Expected, Actual extends Expected> = Actual;

type PageSessionConformsToClient = AssertAssignable<AgentSessionHandle, PageSessionInstance>;
type InjectedProviderConformsToClient = AssertAssignable<AgentProvider, InjectedProvider>;
