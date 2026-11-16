/**
 * Who controls a canister, as the Internet Computer certifies it.
 *
 * A canister's controllers can replace its code or delete it, and with it
 * everything stored there. The IC publishes them (and the hash of the code
 * installed) to anyone through `read_state`, signed by the subnet, so a
 * reader needs no trust in whoever runs the gateway.
 */

import { Cbor, Certificate, lookupResultToBuffer, type HttpAgent } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';

export interface CanisterControl {
  /** The principals that can install code on, stop, or delete the canister. Empty when it has none. */
  controllers: string[];
  /** SHA-256 of the installed code, as hex; null when the canister has none installed. */
  moduleHash: string | null;
}

/** The `controllers` leaf: a CBOR array of principals, as byte strings. */
export function decodeControllers(leaf: Uint8Array): string[] {
  const decoded: unknown = Cbor.decode(leaf);
  if (!Array.isArray(decoded)) throw new Error('The canister certificate lists its controllers in a shape this version does not read');
  return decoded.map((bytes) => {
    if (!(bytes instanceof Uint8Array)) throw new Error('The canister certificate lists a controller that is not a principal');
    return Principal.fromUint8Array(bytes).toText();
  });
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Reads a canister's controllers and code hash from a certificate the subnet
 * signed, checked against `agent`'s root key. Needs no identity.
 */
export async function readCanisterControl(agent: HttpAgent, canisterId: string): Promise<CanisterControl> {
  const canister = Principal.fromText(canisterId);
  const path = (leaf: string): [string, Uint8Array, string] => ['canister', canister.toUint8Array(), leaf];
  const encode = (parts: [string, Uint8Array, string]) => parts.map((part) => (typeof part === 'string' ? new TextEncoder().encode(part) : part));
  const { certificate } = await agent.readState(canister, { paths: [encode(path('controllers')), encode(path('module_hash'))] });
  if (!agent.rootKey) throw new Error('The agent has no root key to check the canister certificate against');
  const verified = await Certificate.create({ certificate, rootKey: agent.rootKey, canisterId: canister });

  const controllers = lookupResultToBuffer(verified.lookup_path(path('controllers')));
  if (!controllers) throw new Error(`The certificate for ${canisterId} does not say who controls it`);
  const hash = lookupResultToBuffer(verified.lookup_path(path('module_hash')));
  return { controllers: decodeControllers(new Uint8Array(controllers)), moduleHash: hash ? toHex(new Uint8Array(hash)) : null };
}
