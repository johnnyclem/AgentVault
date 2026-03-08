/**
 * Agent Communication Service
 *
 * Agent-to-agent messaging with support for direct messages, channels,
 * threading, and priority levels.
 *
 * Default implementation uses an in-memory store; consumers can inject
 * a database-backed adapter by implementing MessageStore.
 */

import { randomUUID } from 'node:crypto';
import type { AgentMessage, SendMessageInput } from '../types.js';

/** Storage adapter interface for agent messages */
export interface MessageStore {
  create(message: AgentMessage): Promise<AgentMessage>;
  getById(id: string): Promise<AgentMessage | null>;
  listByChannel(companyId: string, channel: string): Promise<AgentMessage[]>;
  listInbox(companyId: string, agentId: string): Promise<AgentMessage[]>;
  listSent(companyId: string, agentId: string): Promise<AgentMessage[]>;
  listThread(parentMessageId: string): Promise<AgentMessage[]>;
  acknowledge(id: string, acknowledgedAt: string): Promise<AgentMessage | null>;
}

/** In-memory implementation of MessageStore */
export class InMemoryMessageStore implements MessageStore {
  private messages = new Map<string, AgentMessage>();

  async create(message: AgentMessage): Promise<AgentMessage> {
    this.messages.set(message.id, message);
    return message;
  }

  async getById(id: string): Promise<AgentMessage | null> {
    return this.messages.get(id) ?? null;
  }

  async listByChannel(companyId: string, channel: string): Promise<AgentMessage[]> {
    const results: AgentMessage[] = [];
    for (const msg of this.messages.values()) {
      if (msg.companyId === companyId && msg.channel === channel) {
        results.push(msg);
      }
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listInbox(companyId: string, agentId: string): Promise<AgentMessage[]> {
    const results: AgentMessage[] = [];
    for (const msg of this.messages.values()) {
      if (msg.companyId === companyId && msg.toAgentId === agentId) {
        results.push(msg);
      }
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listSent(companyId: string, agentId: string): Promise<AgentMessage[]> {
    const results: AgentMessage[] = [];
    for (const msg of this.messages.values()) {
      if (msg.companyId === companyId && msg.fromAgentId === agentId) {
        results.push(msg);
      }
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listThread(parentMessageId: string): Promise<AgentMessage[]> {
    const parent = this.messages.get(parentMessageId);
    const results: AgentMessage[] = parent ? [parent] : [];
    for (const msg of this.messages.values()) {
      if (msg.parentMessageId === parentMessageId) {
        results.push(msg);
      }
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async acknowledge(id: string, acknowledgedAt: string): Promise<AgentMessage | null> {
    const msg = this.messages.get(id);
    if (!msg) return null;
    const updated = { ...msg, acknowledgedAt };
    this.messages.set(id, updated);
    return updated;
  }
}

export class CommunicationService {
  constructor(private store: MessageStore = new InMemoryMessageStore()) {}

  async sendMessage(
    companyId: string,
    fromAgentId: string,
    input: SendMessageInput,
  ): Promise<AgentMessage> {
    const message: AgentMessage = {
      id: randomUUID(),
      companyId,
      fromAgentId,
      toAgentId: input.toAgentId,
      channel: input.channel,
      parentMessageId: input.parentMessageId,
      messageType: input.messageType,
      subject: input.subject,
      body: input.body,
      priority: input.priority ?? 'normal',
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
    };
    return this.store.create(message);
  }

  async getChannelMessages(companyId: string, channel: string): Promise<AgentMessage[]> {
    return this.store.listByChannel(companyId, channel);
  }

  async getInbox(companyId: string, agentId: string): Promise<AgentMessage[]> {
    return this.store.listInbox(companyId, agentId);
  }

  async getSentMessages(companyId: string, agentId: string): Promise<AgentMessage[]> {
    return this.store.listSent(companyId, agentId);
  }

  async getThread(messageId: string): Promise<AgentMessage[]> {
    return this.store.listThread(messageId);
  }

  async acknowledgeMessage(messageId: string): Promise<AgentMessage | null> {
    return this.store.acknowledge(messageId, new Date().toISOString());
  }
}
