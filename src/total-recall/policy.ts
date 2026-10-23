/**
 * Total Recall — guardrail policy
 *
 * The policy lives in `volume.json` and says what every connected assistant
 * must do with the volume. AgentVault can't reach into ChatGPT or Claude to
 * force a write, so the guardrail is enforced at the two places AgentVault
 * does control:
 *
 *   1. The MCP server's `initialize` reply carries `instructions` built from
 *      the policy (`policyInstructions`), so every client that connects is
 *      told, in its system context, to record every memory it creates,
 *      recalls or updates, and (when transcript mode is on) every turn.
 *   2. The `total_recall_record` / `total_recall_transcribe` tools accept
 *      only what the policy allows and refuse the rest with a message that
 *      restates the policy, so a client can't quietly write the wrong thing.
 *
 * Fan-out (webhooks, a hook command) is part of the policy too: the writer
 * notifies them, and `agentvault total-recall watch` replays the same
 * fan-out for events written by another process.
 */

import { z } from 'zod';

export const webhookSchema = z.object({
  url: z.string().url(),
  /** Loopback is the default boundary; set to post to another host. */
  allowRemote: z.boolean().default(false),
  /** Optional bearer token sent as Authorization: Bearer <token> */
  bearerToken: z.string().optional(),
});
export type WebhookConfig = z.infer<typeof webhookSchema>;

export const policySchema = z.object({
  /** Record every memory event a connected assistant reports. */
  recordMemories: z.boolean().default(true),
  /** `append`: every conversation turn is appended to transcript.jsonl. */
  transcript: z.enum(['off', 'append']).default('off'),
  /** Providers allowed to write; empty means any. */
  providers: z.array(z.string().min(1)).default([]),
  /** Memory ops recorded; `recalled` is the noisy one people turn off. */
  recordOps: z.array(z.enum(['created', 'recalled', 'updated', 'deleted'])).default([
    'created',
    'recalled',
    'updated',
    'deleted',
  ]),
  /** Where new memory events are POSTed as they are written. */
  webhooks: z.array(webhookSchema).default([]),
  /** argv of a command run per event with the event JSON on stdin. */
  hookCommand: z.array(z.string()).optional(),
});
export type TotalRecallPolicy = z.infer<typeof policySchema>;

export function defaultPolicy(): TotalRecallPolicy {
  return policySchema.parse({});
}

/**
 * The text an MCP client receives as server `instructions`. Written for a
 * model: short, imperative, and names the tools.
 */
export function policyInstructions(policy: TotalRecallPolicy, options: { volumeId?: string } = {}): string {
  const lines: string[] = [];
  lines.push(
    `This server is an AgentVault "total-recall" volume${options.volumeId ? ` (${options.volumeId})` : ''}: a write-once, read-many archive of memories across assistants.`,
  );
  if (policy.recordMemories) {
    const ops = policy.recordOps.join(', ');
    lines.push(
      `GUARDRAIL: whenever you create, recall, update or delete a memory about the user (your own memory feature included), call total_recall_record in the same turn with op set to one of: ${ops}. Pass the memory's stable key, its full content, and provider set to your own name (e.g. "chatgpt" or "claude"). Never skip this, and never summarize or shorten the content you record.`,
    );
  }
  if (policy.transcript === 'append') {
    lines.push(
      'TRANSCRIPT: this volume keeps a full transcript. After each user message and each of your replies, call total_recall_transcribe with the role, the complete text, and a stable sessionId for the conversation.',
    );
  }
  lines.push(
    'To learn what other assistants remembered, call total_recall_pull with the since_seq you last saw (start at 0), or total_recall_search / total_recall_list. The archive is append-only: nothing you read here can be edited or removed, only superseded by a newer event.',
  );
  if (policy.providers.length > 0) {
    lines.push(`Only these providers may write: ${policy.providers.join(', ')}.`);
  }
  return lines.join('\n');
}

/** Why the policy refuses a write, or null when it allows it. */
export function policyRefusal(
  policy: TotalRecallPolicy,
  write: { kind: 'memory'; op: TotalRecallPolicy['recordOps'][number]; provider: string } | { kind: 'transcript'; provider: string },
): string | null {
  if (policy.providers.length > 0 && !policy.providers.includes(write.provider)) {
    return `Provider "${write.provider}" is not allowed to write to this volume (allowed: ${policy.providers.join(', ')}).`;
  }
  if (write.kind === 'memory') {
    if (!policy.recordMemories) return 'This volume does not record memory events (policy.recordMemories is false).';
    if (!policy.recordOps.includes(write.op)) {
      return `This volume does not record "${write.op}" events (policy.recordOps: ${policy.recordOps.join(', ')}).`;
    }
    return null;
  }
  if (policy.transcript !== 'append') {
    return 'This volume has transcript mode off (policy.transcript is "off"); enable it with `agentvault total-recall policy --transcript append`.';
  }
  return null;
}
