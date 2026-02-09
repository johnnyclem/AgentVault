/**
 * Identity Management
 *
 * Provides identity management via icp-cli.
 * List identities, create new identities,
 * import/export identities and manage default identity.
 */

import { icpcli } from '../icp/icpcli.js';

/**
 * List all available identities.
 *
 * @param options - Common ICP options
 * @returns Command result with identity list
 */
export async function listIdentities(
  options: any = {},
): Promise<any> {
  return icpcli.identityList(options);
}

/**
 * Create a new identity.
 *
 * @param name - Identity name
 * @param options - Common ICP options
 * @returns Command result
 */
export async function createIdentity(
  name: string,
  options: any = {},
): Promise<any> {
  return icpcli.identityNew({ name }, options);
}

/**
 * Export an identity to PEM file.
 *
 * @param name - Identity name
 * @param pemFile - Path to PEM file (for export)
 * @param options - Common ICP options
 * @returns Command result with PEM content
 */
export async function exportIdentity(
  name: string,
  pemFile: string,
  options: any = {},
): Promise<any> {
  return icpcli.identityExport({ name, pemFile }, options);
}

/**
 * Get the principal of a default or named identity.
 *
 * @param name - Identity name (if null, use default)
 * @param options - Common ICP options
 * @returns Command result with principal
 */
export async function getIdentityPrincipal(
  name?: string,
  options: any = {},
): Promise<string> {
  return icpcli.identityPrincipal({ name }, options);
}

/**
 * Import an identity from a PEM file.
 *
 * @param name - Identity name to import
 * @param pemFile - Path to PEM file
 * @param options - Common ICP options
 * @returns Command result
 */
export async function importIdentity(
  name: string,
  pemFile: string,
  options: any = {},
): Promise<any> {
  return icpcli.identityImport({ name, pemFile }, options);
}

/**
 * Set a default identity.
 *
 * @param name - Identity name to set as default
 * @param options - Common ICP options
 * @returns Command result
 */
export async function setDefaultIdentity(
  name: string,
  options: any = {},
): Promise<any> {
  return icpcli.identityPrincipal({ name }, options);
}
