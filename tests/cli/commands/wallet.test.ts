import { beforeEach, describe, expect, it, vi } from 'vitest';

const walletMocks = vi.hoisted(() => ({
  generateWallet: vi.fn(),
  importWalletFromMnemonic: vi.fn(),
  importWalletFromSeed: vi.fn(),
  importWalletFromPrivateKey: vi.fn(),
  createWalletProvider: vi.fn(),
}));

const inquirerMocks = vi.hoisted(() => ({
  prompt: vi.fn(),
}));

const providerMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  getBalance: vi.fn(),
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: inquirerMocks.prompt,
  },
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn(() => ({
      succeed: vi.fn(),
      fail: vi.fn(),
    })),
  })),
}));

vi.mock('../../../src/wallet/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/wallet/index.js')>(
    '../../../src/wallet/index.js'
  );

  return {
    ...actual,
    createWalletProvider: walletMocks.createWalletProvider,
    generateWallet: walletMocks.generateWallet,
    importWalletFromSeed: walletMocks.importWalletFromSeed,
    importWalletFromMnemonic: walletMocks.importWalletFromMnemonic,
    importWalletFromPrivateKey: walletMocks.importWalletFromPrivateKey,
  };
});

import {
  handleConnect,
  handleGenerateNonInteractive,
  handleImportNonInteractive,
  normalizeChain,
} from '../../../cli/commands/wallet.js';

describe('wallet command chain support', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    walletMocks.generateWallet.mockImplementation((_agentId: string, chain: string) => ({
      id: 'wallet-1',
      chain,
      address: chain === 'icp' ? 'aaaaa-aa' : 'dGVzdF9hZHJlc3Mtd2l0aC1iYXNlNjR1cmxjaGFyczEyMw',
      createdAt: Date.now(),
    }));

    walletMocks.importWalletFromMnemonic.mockImplementation((_agentId: string, chain: string) => ({
      id: 'wallet-2',
      chain,
      address: chain === 'icp' ? 'bbbbb-bb' : 'YW5vdGhlcl9hZGRyZXNzLWFyd2VhdmUxMjM0NTY3ODkwMTI',
      createdAt: Date.now(),
    }));
    walletMocks.importWalletFromSeed.mockImplementation((_agentId: string, chain: string) => ({
      id: 'wallet-2',
      chain,
      address: chain === 'icp' ? 'ccccc-cc' : 'dG9lc3RfYWRkcmVzcy1hcmVhc3R5ZXI=' ,
      createdAt: Date.now(),
    }));

    walletMocks.importWalletFromPrivateKey.mockImplementation((_agentId: string, chain: string) => ({
      id: 'wallet-3',
      chain,
      address: chain === 'icp' ? 'ccccc-cc' : 'cHJpdmF0ZWtleV9hZGRyZXNzLWFyd2VhdmUxMjM0NTY3ODk',
      createdAt: Date.now(),
    }));

    const provider = {
      connect: providerMocks.connect.mockResolvedValue(undefined),
      getBalance: providerMocks.getBalance.mockResolvedValue({
        amount: '1',
        denomination: 'IC',
        blockNumber: 1,
      }),
    };

    walletMocks.createWalletProvider.mockReturnValue(provider);
  });

  it('normalizes icp chain alias', () => {
    expect(normalizeChain('icp')).toBe('icp');
  });

  it('normalizes arweave aliases', () => {
    expect(normalizeChain('arweave')).toBe('arweave');
    expect(normalizeChain('ar')).toBe('arweave');
  });

  it('generates wallet for icp chain', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleGenerateNonInteractive({
      agentId: 'agent-1',
      chain: 'icp',
      json: true,
    });

    expect(walletMocks.generateWallet).toHaveBeenCalledWith('agent-1', 'icp');
    logSpy.mockRestore();
  });

  it('generates wallet for arweave chain', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleGenerateNonInteractive({
      agentId: 'agent-1',
      chain: 'arweave',
      json: true,
    });

    expect(walletMocks.generateWallet).toHaveBeenCalledWith('agent-1', 'arweave');
    logSpy.mockRestore();
  });

  it('imports mnemonic wallet for icp chain', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    await handleImportNonInteractive({
      agentId: 'agent-1',
      chain: 'icp',
      mnemonic,
      json: true,
    });

    expect(walletMocks.importWalletFromMnemonic).toHaveBeenCalledWith('agent-1', 'icp', mnemonic);
    logSpy.mockRestore();
  });

  it('imports private-key wallet for arweave chain', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const privateKey = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

    await handleImportNonInteractive({
      agentId: 'agent-1',
      chain: 'arweave',
      privateKey,
      json: true,
    });

    expect(walletMocks.importWalletFromPrivateKey).toHaveBeenCalledWith('agent-1', 'arweave', privateKey);
    logSpy.mockRestore();
  });

  it('creates and connects an icp wallet via interactive connect flow', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    inquirerMocks.prompt
      .mockResolvedValueOnce({ method: 'generate' })
      .mockResolvedValueOnce({ chain: 'icp' });

    await handleConnect('agent-1');

    expect(walletMocks.generateWallet).toHaveBeenCalledWith('agent-1', 'icp');
    expect(walletMocks.createWalletProvider).toHaveBeenCalledWith('icp', { isTestnet: false });
    expect(providerMocks.connect).toHaveBeenCalledTimes(1);
    expect(providerMocks.getBalance).toHaveBeenCalledWith('aaaaa-aa');
    expect(inquirerMocks.prompt).toHaveBeenCalledTimes(2);

    const chainPrompt = inquirerMocks.prompt.mock.calls[1]?.[0]?.[0];
    expect(chainPrompt).toBeDefined();
    const chainValues = (chainPrompt as { choices: Array<{ value: string }> }).choices.map((item) => item.value);
    expect(chainValues).toEqual(expect.arrayContaining(['icp', 'arweave']));
    logSpy.mockRestore();
  });

  it('creates and connects an arweave wallet via interactive connect flow', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    inquirerMocks.prompt
      .mockResolvedValueOnce({ method: 'generate' })
      .mockResolvedValueOnce({ chain: 'arweave' });

    await handleConnect('agent-1');

    expect(walletMocks.generateWallet).toHaveBeenCalledWith('agent-1', 'arweave');
    expect(walletMocks.createWalletProvider).toHaveBeenCalledWith('arweave', { isTestnet: false });
    expect(providerMocks.connect).toHaveBeenCalledTimes(1);
    expect(providerMocks.getBalance).toHaveBeenCalledWith('dGVzdF9hZHJlc3Mtd2l0aC1iYXNlNjR1cmxjaGFyczEyMw');
    logSpy.mockRestore();
  });

  it('creates and connects an icp wallet from seed via interactive connect flow', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    inquirerMocks.prompt
      .mockResolvedValueOnce({ method: 'seed' })
      .mockResolvedValueOnce({ chain: 'icp' })
      .mockResolvedValueOnce({ seedPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', derivationPath: '' });

    await handleConnect('agent-1');

    expect(walletMocks.importWalletFromSeed).toHaveBeenCalledWith(
      'agent-1',
      'icp',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      undefined
    );
    expect(walletMocks.createWalletProvider).toHaveBeenCalledWith('icp', { isTestnet: false });
    expect(providerMocks.connect).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it('creates and connects an arweave wallet from private-key via interactive connect flow', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const privateKey = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    inquirerMocks.prompt
      .mockResolvedValueOnce({ method: 'private-key' })
      .mockResolvedValueOnce({ chain: 'arweave' })
      .mockResolvedValueOnce({ privateKey });

    await handleConnect('agent-1');

    expect(walletMocks.importWalletFromPrivateKey).toHaveBeenCalledWith('agent-1', 'arweave', privateKey);
    expect(walletMocks.createWalletProvider).toHaveBeenCalledWith('arweave', { isTestnet: false });
    expect(providerMocks.connect).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });
});
