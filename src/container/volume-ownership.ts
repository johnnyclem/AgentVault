/**
 * Who owns a Docker volume, decided by its labels and nothing else.
 *
 * Volume names are `av-<agent>-<key>` and both parts may contain dashes, so different (agent, key) pairs can derive
 * the same name ("my" + "agent-data" and "my-agent" + "data"). The agent name and volume paths come from the image's
 * manifest, and `docker volume create` of an existing name succeeds without looking at who made it. Anything that
 * mounts, fills or removes a volume therefore goes through here first.
 */

import { ContainerError, LABEL_AGENT, LABEL_MANAGED, LABEL_VOLUME_KEY } from './types.js';
import type { ContainerRuntime } from './types.js';
import { resourceNames } from './validate.js';

/**
 * Make sure the Docker volume for (agent, key) exists and is THIS agent's; true when this call created it.
 *
 * An existing volume is used only if its labels say it belongs to exactly this agent and key. An unlabelled one
 * (somebody else's) or another agent's is refused, never adopted, and so never removed by a rollback either. Only a
 * volume this call created (returns true) may be taken away again if something later fails.
 */
export async function ensureAgentVolume(
  runtime: ContainerRuntime,
  agent: string,
  key: string,
  name: string = resourceNames(agent).volume(key)
): Promise<boolean> {
  const existing = await runtime.inspectVolume(name);
  if (existing === null) {
    await runtime.ensureVolume(name, { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: agent, [LABEL_VOLUME_KEY]: key });
    return true;
  }
  const labels = existing.labels;
  if (labels[LABEL_MANAGED] !== 'true') {
    throw new ContainerError(
      'POLICY_VIOLATION',
      `Docker volume ${name} already exists but was not created by AgentVault, so it will not be used or removed. ` +
        `If it is yours to discard: docker volume rm ${name}`
    );
  }
  if (labels[LABEL_AGENT] === agent && labels[LABEL_VOLUME_KEY] === key) return false;
  const shown = (value: string | undefined): string => JSON.stringify((value ?? '').slice(0, 64));
  throw new ContainerError(
    'POLICY_VIOLATION',
    `Docker volume ${name} belongs to agent ${shown(labels[LABEL_AGENT])} (volume ${shown(labels[LABEL_VOLUME_KEY])}), not to "${agent}" (volume "${key}"): ` +
      'agent and volume names combine into the same Docker name. Use a different agent name (--name) or volume name.'
  );
}
