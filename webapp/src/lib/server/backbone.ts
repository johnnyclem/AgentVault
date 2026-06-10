/**
 * Backbone service singletons for the webapp API routes.
 *
 * These use the in-memory store implementations by default.
 * In a production Paperclip integration, these would be replaced
 * with database-backed stores.
 */

import { MemoryService } from '../../../../src/backbone/services/memory';
import { KnowledgeService } from '../../../../src/backbone/services/knowledge';
import { CommunicationService } from '../../../../src/backbone/services/communication';
import { ConsensusService } from '../../../../src/backbone/services/consensus';
import { VaultHealthService } from '../../../../src/backbone/services/vault-health';

// Singleton instances (persist across requests in the same process)
let memoryService: MemoryService | null = null;
let knowledgeService: KnowledgeService | null = null;
let communicationService: CommunicationService | null = null;
let consensusService: ConsensusService | null = null;
let vaultHealthService: VaultHealthService | null = null;

export function getMemoryService(): MemoryService {
  if (!memoryService) memoryService = new MemoryService();
  return memoryService;
}

export function getKnowledgeService(): KnowledgeService {
  if (!knowledgeService) knowledgeService = new KnowledgeService();
  return knowledgeService;
}

export function getCommunicationService(): CommunicationService {
  if (!communicationService) communicationService = new CommunicationService();
  return communicationService;
}

export function getConsensusService(): ConsensusService {
  if (!consensusService) consensusService = new ConsensusService();
  return consensusService;
}

export function getVaultHealthService(): VaultHealthService {
  if (!vaultHealthService) vaultHealthService = new VaultHealthService();
  return vaultHealthService;
}
