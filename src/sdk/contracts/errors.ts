/**
 * Exchange error decoding utility
 * Decodes custom revert reasons from the Exchange contract
 */

import { type Hex, decodeErrorResult } from "viem";
import { ExchangeAbi } from "./abi.js";

/**
 * Decoded exchange error with name and parameters
 */
export interface DecodedExchangeError {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Decode a revert reason from the Exchange contract into a human-readable error.
 * Returns null if the data doesn't match any known error selector.
 */
export function decodeExchangeError(data: Hex): DecodedExchangeError | null {
  try {
    const decoded = decodeErrorResult({
      abi: ExchangeAbi,
      data,
    });

    // Build args record from decoded values
    const args: Record<string, unknown> = {};
    if (decoded.args) {
      // decodeErrorResult returns args as an array-like with named properties
      const errorAbi = ExchangeAbi.find(
        (e) => e.type === "error" && e.name === decoded.errorName,
      );
      if (errorAbi && "inputs" in errorAbi) {
        for (let i = 0; i < errorAbi.inputs.length; i++) {
          const input = errorAbi.inputs[i];
          const value = (decoded.args as unknown as unknown[])[i];
          args[input.name] = typeof value === "bigint" ? value.toString() : value;
        }
      }
    }

    return { name: decoded.errorName, args };
  } catch {
    return null;
  }
}

/**
 * Format a decoded error into a human-readable string.
 */
export function formatExchangeError(error: DecodedExchangeError): string {
  const params = Object.entries(error.args);
  if (params.length === 0) return error.name;
  const paramStr = params.map(([k, v]) => `${k}=${v}`).join(", ");
  return `${error.name}(${paramStr})`;
}

/**
 * Try to decode a hex error and return a formatted string.
 * Falls back to the raw hex if decoding fails.
 */
export function decodeExchangeErrorString(data: Hex): string {
  const decoded = decodeExchangeError(data);
  if (decoded) return formatExchangeError(decoded);
  return `Unknown error: ${data}`;
}
