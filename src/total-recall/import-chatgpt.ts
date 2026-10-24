/**
 * Total Recall — importing what a provider's data export does give you
 *
 * A ChatGPT data export ships `conversations.json`: an array of
 * conversations, each a `mapping` of message nodes. This turns it into
 * transcript lines (one session per conversation, in create_time order)
 * and, from a pasted "Manage memories" list, into `created` memory events.
 * Lines already in the volume are skipped by id, so re-running an import
 * after a newer export adds only what is new.
 */

import * as fs from 'node:fs';
import type { TotalRecallVolume } from './volume.js';
import type { TranscriptMessageInput } from './format.js';
import { contentId } from './format.js';

export interface ImportSummary {
  conversations: number;
  messages: number;
  skipped: number;
}

interface ChatGptNode {
  id?: string;
  message?: {
    id?: string;
    author?: { role?: string };
    create_time?: number | null;
    content?: { content_type?: string; parts?: unknown[]; text?: string };
    metadata?: { model_slug?: string; is_visually_hidden_from_conversation?: boolean };
  } | null;
}

interface ChatGptConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number;
  mapping?: Record<string, ChatGptNode>;
}

const ROLE_MAP: Record<string, TranscriptMessageInput['role']> = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
  tool: 'tool',
};

function nodeText(node: ChatGptNode): string {
  const content = node.message?.content;
  if (!content) return '';
  if (typeof content.text === 'string') return content.text;
  if (!Array.isArray(content.parts)) return '';
  return content.parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') {
        return (p as { text: string }).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Transcript inputs for one exported conversation, oldest first. */
export function chatGptConversationMessages(conversation: ChatGptConversation): TranscriptMessageInput[] {
  const sessionId = conversation.conversation_id ?? conversation.id;
  if (!sessionId || !conversation.mapping) return [];
  const nodes = Object.values(conversation.mapping).filter((n) => n.message);
  nodes.sort((a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0));
  const out: TranscriptMessageInput[] = [];
  for (const node of nodes) {
    const msg = node.message!;
    const role = ROLE_MAP[msg.author?.role ?? ''];
    if (!role) continue;
    if (msg.metadata?.is_visually_hidden_from_conversation) continue;
    const content = nodeText(node).trim();
    if (!content) continue;
    const createTime = msg.create_time ?? conversation.create_time;
    out.push({
      id: `chatgpt_${msg.id ?? node.id ?? contentId('n', sessionId, content)}`,
      role,
      content,
      sessionId,
      provider: 'chatgpt',
      timestamp: createTime ? new Date(createTime * 1000).toISOString() : new Date(0).toISOString(),
      ...(msg.metadata?.model_slug ? { model: msg.metadata.model_slug } : {}),
    });
  }
  return out;
}

function readConversations(filePath: string): ChatGptConversation[] {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!Array.isArray(data)) throw new Error(`${filePath}: expected a JSON array of conversations`);
  return data as ChatGptConversation[];
}

/** Append one conversation's new messages as a single batch; returns how many were new and how many were already there. */
function importConversation(
  volume: TotalRecallVolume,
  conversation: ChatGptConversation,
  existing: Set<string>,
  summary: ImportSummary,
): void {
  const fresh: TranscriptMessageInput[] = [];
  const messages = chatGptConversationMessages(conversation);
  if (messages.length === 0) return;
  summary.conversations += 1;
  for (const message of messages) {
    if (existing.has(message.id!)) {
      summary.skipped += 1;
      continue;
    }
    existing.add(message.id!);
    fresh.push(message);
  }
  volume.appendTranscriptBatch(fresh);
  summary.messages += fresh.length;
}

/** Append every message of a `conversations.json` export to the transcript. */
export function importChatGptConversations(volume: TotalRecallVolume, filePath: string): ImportSummary {
  const conversations = readConversations(filePath);
  const existing = volume.transcriptIds();
  const summary: ImportSummary = { conversations: 0, messages: 0, skipped: 0 };
  for (const conversation of conversations) importConversation(volume, conversation, existing, summary);
  return summary;
}

/**
 * The same import, yielding to the event loop between batches of
 * conversations so a spinner can keep turning, and reporting how far it is.
 */
export async function importChatGptConversationsAsync(
  volume: TotalRecallVolume,
  filePath: string,
  options: { onProgress?: (done: number, total: number) => void } = {},
): Promise<ImportSummary> {
  const conversations = readConversations(filePath);
  const existing = volume.transcriptIds();
  const summary: ImportSummary = { conversations: 0, messages: 0, skipped: 0 };
  for (let i = 0; i < conversations.length; i++) {
    importConversation(volume, conversations[i]!, existing, summary);
    if ((i + 1) % 25 === 0 || i + 1 === conversations.length) {
      options.onProgress?.(i + 1, conversations.length);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return summary;
}

/**
 * Memories pasted from a provider's memory manager, one per line or
 * paragraph (leading list markers and numbering are stripped). Each becomes
 * a `created` event keyed by a hash of its text, so a re-import is a no-op.
 */
export function parseMemoryList(text: string): string[] {
  return text
    .split(/\n\s*\n|\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0);
}

export function importMemoryList(
  volume: TotalRecallVolume,
  text: string,
  options: { provider: string; agent?: string; tags?: string[] },
): { imported: number; skipped: number } {
  const existing = new Set(volume.foldMemories({ includeDeleted: true, provider: options.provider }).map((m) => m.key));
  let imported = 0;
  let skipped = 0;
  for (const content of parseMemoryList(text)) {
    const key = contentId('mem', content);
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    volume.appendMemoryEvent({
      op: 'created',
      source: { provider: options.provider, ...(options.agent ? { agent: options.agent } : {}) },
      memory: { key, content, tags: options.tags ?? ['imported'] },
    });
    existing.add(key);
    imported += 1;
  }
  return { imported, skipped };
}
