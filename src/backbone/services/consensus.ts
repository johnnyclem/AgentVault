/**
 * Consensus Service
 *
 * Proposal and voting mechanism for agent governance with quorum resolution.
 *
 * Proposal lifecycle:  draft → open → passed | rejected | vetoed | expired
 *
 * Quorum types:
 *   majority       – votesFor > votesAgainst
 *   supermajority  – votesFor >= 2/3 of total votes
 *   unanimous      – zero against votes, at least one for vote
 *   board_approval – majority, but board can veto independently
 *
 * When a proposal passes with a linked knowledgeEntryId, the knowledge
 * entry should be automatically ratified by the caller.
 */

import { randomUUID } from 'node:crypto';
import type {
  ConsensusProposal,
  ConsensusVote,
  CreateProposalInput,
  CastVoteInput,
} from '../types.js';
import type { ProposalStatus, QuorumType } from '../constants.js';

/** Storage adapter interface for consensus */
export interface ConsensusStore {
  listProposals(companyId: string, status?: ProposalStatus): Promise<ConsensusProposal[]>;
  getProposal(id: string): Promise<ConsensusProposal | null>;
  createProposal(proposal: ConsensusProposal): Promise<ConsensusProposal>;
  updateProposal(id: string, partial: Partial<ConsensusProposal>): Promise<ConsensusProposal | null>;
  listVotes(proposalId: string): Promise<ConsensusVote[]>;
  getVoteByVoter(proposalId: string, voterId: string): Promise<ConsensusVote | null>;
  createVote(vote: ConsensusVote): Promise<ConsensusVote>;
}

/** In-memory implementation of ConsensusStore */
export class InMemoryConsensusStore implements ConsensusStore {
  private proposals = new Map<string, ConsensusProposal>();
  private votes = new Map<string, ConsensusVote>();

  async listProposals(companyId: string, status?: ProposalStatus): Promise<ConsensusProposal[]> {
    const results: ConsensusProposal[] = [];
    for (const p of this.proposals.values()) {
      if (p.companyId !== companyId) continue;
      if (status && p.status !== status) continue;
      results.push(p);
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getProposal(id: string): Promise<ConsensusProposal | null> {
    return this.proposals.get(id) ?? null;
  }

  async createProposal(proposal: ConsensusProposal): Promise<ConsensusProposal> {
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  async updateProposal(
    id: string,
    partial: Partial<ConsensusProposal>,
  ): Promise<ConsensusProposal | null> {
    const existing = this.proposals.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...partial, updatedAt: new Date().toISOString() };
    this.proposals.set(id, updated);
    return updated;
  }

  async listVotes(proposalId: string): Promise<ConsensusVote[]> {
    const results: ConsensusVote[] = [];
    for (const v of this.votes.values()) {
      if (v.proposalId === proposalId) results.push(v);
    }
    return results;
  }

  async getVoteByVoter(proposalId: string, voterId: string): Promise<ConsensusVote | null> {
    for (const v of this.votes.values()) {
      if (v.proposalId === proposalId && v.voterId === voterId) return v;
    }
    return null;
  }

  async createVote(vote: ConsensusVote): Promise<ConsensusVote> {
    this.votes.set(vote.id, vote);
    return vote;
  }
}

/** Check if quorum is reached and determine outcome */
function resolveQuorum(
  quorumType: QuorumType,
  votesFor: number,
  votesAgainst: number,
): { resolved: boolean; status: 'passed' | 'rejected' } | null {
  const totalDecisive = votesFor + votesAgainst;
  if (totalDecisive === 0) return null;

  switch (quorumType) {
    case 'majority':
    case 'board_approval':
      if (votesFor > votesAgainst) {
        return { resolved: true, status: 'passed' };
      }
      if (votesAgainst > votesFor) {
        return { resolved: true, status: 'rejected' };
      }
      return null;

    case 'supermajority': {
      const total = votesFor + votesAgainst;
      if (total > 0 && votesFor / total >= 2 / 3) {
        return { resolved: true, status: 'passed' };
      }
      if (total > 0 && votesAgainst / total > 1 / 3) {
        return { resolved: true, status: 'rejected' };
      }
      return null;
    }

    case 'unanimous':
      if (votesAgainst > 0) {
        return { resolved: true, status: 'rejected' };
      }
      if (votesFor > 0) {
        return { resolved: true, status: 'passed' };
      }
      return null;

    default:
      return null;
  }
}

export class ConsensusService {
  constructor(private store: ConsensusStore = new InMemoryConsensusStore()) {}

  async listProposals(
    companyId: string,
    status?: ProposalStatus,
  ): Promise<ConsensusProposal[]> {
    return this.store.listProposals(companyId, status);
  }

  async getProposal(id: string): Promise<ConsensusProposal | null> {
    return this.store.getProposal(id);
  }

  async createProposal(
    companyId: string,
    createdBy: string,
    input: CreateProposalInput,
  ): Promise<ConsensusProposal> {
    const now = new Date().toISOString();
    const proposal: ConsensusProposal = {
      id: randomUUID(),
      companyId,
      title: input.title,
      description: input.description,
      proposalType: input.proposalType,
      status: 'draft',
      quorumType: input.quorumType ?? 'majority',
      createdBy,
      knowledgeEntryId: input.knowledgeEntryId,
      votesFor: 0,
      votesAgainst: 0,
      votesAbstain: 0,
      expiresAt: input.expiresAt,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.createProposal(proposal);
  }

  /**
   * Cast a vote on a proposal. Returns the updated proposal.
   * Automatically resolves the proposal if quorum is reached.
   */
  async castVote(
    proposalId: string,
    voterId: string,
    input: CastVoteInput,
  ): Promise<{ vote: ConsensusVote; proposal: ConsensusProposal } | null> {
    const proposal = await this.store.getProposal(proposalId);
    if (!proposal) return null;

    if (proposal.status !== 'open') {
      throw new Error(`Cannot vote on proposal with status "${proposal.status}"`);
    }

    const existingVote = await this.store.getVoteByVoter(proposalId, voterId);
    if (existingVote) {
      throw new Error('Voter has already cast a vote on this proposal');
    }

    const vote: ConsensusVote = {
      id: randomUUID(),
      proposalId,
      voterId,
      vote: input.vote,
      reasoning: input.reasoning,
      createdAt: new Date().toISOString(),
    };
    await this.store.createVote(vote);

    // Update vote counts
    const updates: Partial<ConsensusProposal> = {};
    switch (input.vote) {
      case 'for':
        updates.votesFor = proposal.votesFor + 1;
        break;
      case 'against':
        updates.votesAgainst = proposal.votesAgainst + 1;
        break;
      case 'abstain':
        updates.votesAbstain = proposal.votesAbstain + 1;
        break;
    }

    const updatedProposal = await this.store.updateProposal(proposalId, updates);
    if (!updatedProposal) return null;

    // Check quorum
    const resolution = resolveQuorum(
      updatedProposal.quorumType,
      updatedProposal.votesFor,
      updatedProposal.votesAgainst,
    );

    if (resolution?.resolved) {
      const resolved = await this.store.updateProposal(proposalId, {
        status: resolution.status,
        resolvedAt: new Date().toISOString(),
      });
      return { vote, proposal: resolved ?? updatedProposal };
    }

    return { vote, proposal: updatedProposal };
  }

  /** Open a draft proposal for voting */
  async openProposal(id: string): Promise<ConsensusProposal | null> {
    const proposal = await this.store.getProposal(id);
    if (!proposal || proposal.status !== 'draft') return null;
    return this.store.updateProposal(id, { status: 'open' });
  }

  /** Board veto — immediately sets status to vetoed */
  async vetoProposal(id: string): Promise<ConsensusProposal | null> {
    const proposal = await this.store.getProposal(id);
    if (!proposal || (proposal.status !== 'open' && proposal.status !== 'draft')) return null;
    return this.store.updateProposal(id, {
      status: 'vetoed',
      resolvedAt: new Date().toISOString(),
    });
  }

  async listVotes(proposalId: string): Promise<ConsensusVote[]> {
    return this.store.listVotes(proposalId);
  }
}
