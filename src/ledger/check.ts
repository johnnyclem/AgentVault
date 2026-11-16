/**
 * Checking a canister from outside: who controls it, who owns the repository on it, and what
 * role the gateway would hold there.
 *
 * Anchoring to a canister someone else owns is safe only if the owner kept the powers that
 * matter. A gateway that is an authorized writer can add commits and branches and nothing
 * else; it cannot rewrite what is there, authorize anyone, switch the canister off, or replace
 * or delete it. Those belong to the repository's owner and to the canister's controllers, and
 * the controllers are what to look at: they can wipe the canister whatever the repository says.
 */

import { createMemoryRepoActor, createMemoryRepoAgent, validateCanisterId } from '../canister/memory-repo-actor.js';
import { readCanisterControl, type CanisterControl } from '../canister/memory-repo-control.js';

export type FindingLevel = 'ok' | 'note' | 'warn' | 'problem';

export interface Finding {
  level: FindingLevel;
  text: string;
}

/** What a canister says about itself, all of it readable without a key. */
export interface CanisterFacts {
  canisterId: string;
  initialized: boolean;
  /** The repository's owner; empty until it is initialized. */
  owner: string;
  frozen: boolean;
  killed: boolean;
  /** Principals the owner authorized to write, not counting the owner. */
  authorizedCount: number;
  control: CanisterControl;
}

/** Reads a canister's repository settings and its certified controllers. */
export async function readCanisterFacts(options: { canisterId: string; host: string }): Promise<CanisterFacts> {
  validateCanisterId(options.canisterId);
  const agent = await createMemoryRepoAgent(options.host);
  const actor = createMemoryRepoActor(options.canisterId, agent);
  const [repo, security, control] = await Promise.all([actor.getRepoStatus(), actor.getSecurityStatus(), readCanisterControl(agent, options.canisterId)]);
  return {
    canisterId: options.canisterId,
    initialized: repo.initialized,
    owner: repo.initialized ? security.owner : '',
    frozen: security.frozenMode,
    killed: security.canisterKilled,
    authorizedCount: Number(security.authorizedCount),
    control,
  };
}

const list = (principals: readonly string[]): string => principals.join(', ');

/**
 * What the facts mean for anchoring, worst first within each kind. `gateway` is the principal the
 * gateway signs as, when known.
 */
export function assessCanister(facts: CanisterFacts, gateway?: string): Finding[] {
  const findings: Finding[] = [];
  const add = (level: FindingLevel, text: string) => findings.push({ level, text });
  const { controllers, moduleHash } = facts.control;

  if (controllers.length === 0) {
    add('note', 'No one controls this canister, so its code can never change and it can never be deleted.');
  } else if (!facts.initialized) {
    add('note', `Controlled by ${list(controllers)}.`);
  } else {
    const others = controllers.filter((principal) => principal !== facts.owner);
    const named = others.map((principal) => (principal === gateway ? `${principal} (the gateway)` : principal));
    const powers = 'who can replace its code or delete it, and everything anchored here with it';
    if (!controllers.includes(facts.owner)) {
      add('warn', `The repository owner (${facts.owner}) does not control the canister. ${list(named)} control it, ${powers}.`);
    } else if (others.length > 0) {
      add('warn', `The canister is also controlled by ${list(named)}, ${powers}.`);
    } else {
      add('ok', `Only the repository owner (${facts.owner}) controls the canister: nobody else can replace its code or delete it.`);
    }
  }

  if (!facts.initialized) {
    add('problem', 'The canister has no repository yet. Its owner must run `agentvault memory init` before anything can be anchored here.');
  } else {
    if (facts.killed) add('problem', 'The canister is switched off: it refuses every write until its owner runs reviveCanister.');
    if (facts.frozen) add('warn', 'Writes are frozen: nothing can be anchored until the owner unlocks them (manualUnlock).');
    if (gateway && gateway === facts.owner) {
      add(
        'warn',
        `The gateway signs as the repository owner (${gateway}), so whoever runs it holds the owner's powers. To keep the canister with someone else, the owner keeps their own key and authorizes a separate one for the gateway.`,
      );
    } else if (gateway && facts.authorizedCount === 0) {
      add('problem', `Nobody is authorized to write here, so ${gateway} will be refused. The owner can allow it with \`agentvault memory authorize ${gateway}\`.`);
    } else if (gateway) {
      add(
        'note',
        `${gateway} can write only if the owner authorized it. The canister lists ${facts.authorizedCount} authorized writer${facts.authorizedCount === 1 ? '' : 's'} but not which; if it is not one of them, the first anchor is refused and names the command to run.`,
      );
    } else {
      add('note', `${facts.authorizedCount} writer${facts.authorizedCount === 1 ? ' is' : 's are'} authorized besides the owner.`);
    }
  }
  if (moduleHash) add('note', `Installed code: ${moduleHash}`);
  const order: FindingLevel[] = ['problem', 'warn', 'ok', 'note'];
  return findings.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
}
