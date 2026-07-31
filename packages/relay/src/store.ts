import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentCert, Hex } from '@agentport/protocol';
import { verifyCert } from '@agentport/protocol';

/**
 * The relay's only durable state: which agents each user has paired.
 *
 * Deliberately not a database. The relay is meant to hold as little as
 * possible — it cannot mint certs, and once end-to-end encryption lands it
 * will not be able to read session traffic either.
 */
export class CertStore {
  #byAgent = new Map<Hex, AgentCert>();
  #path: string | undefined;

  constructor(path?: string) {
    this.#path = path;
    if (path) this.#load();
  }

  #load(): void {
    try {
      const raw = readFileSync(this.#path!, 'utf8');
      const certs: AgentCert[] = JSON.parse(raw);
      for (const cert of certs) {
        if (verifyCert(cert)) this.#byAgent.set(cert.agent, cert);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  #persist(): void {
    if (!this.#path) return;
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify([...this.#byAgent.values()], null, 2));
  }

  put(cert: AgentCert): void {
    if (!verifyCert(cert)) throw new Error('refusing to store cert with invalid signature');
    this.#byAgent.set(cert.agent, cert);
    this.#persist();
  }

  get(agent: Hex): AgentCert | undefined {
    return this.#byAgent.get(agent);
  }

  forUser(user: Hex): AgentCert[] {
    return [...this.#byAgent.values()].filter((cert) => cert.user === user);
  }

  /** Every stored cert, used to seed the in-memory index at boot. */
  all(): AgentCert[] {
    return [...this.#byAgent.values()];
  }

  /** Revocation: forget the binding entirely. */
  remove(agent: Hex): boolean {
    const removed = this.#byAgent.delete(agent);
    if (removed) this.#persist();
    return removed;
  }
}
