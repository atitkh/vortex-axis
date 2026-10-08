/** Protocol version this package defines. Bump on any wire-visible change. */
export const PROTOCOL_VERSION = 1;

/** Oldest client protocol version the server still accepts. */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;

/** WebSocket path a client connects to. */
export const CLIENT_SOCKET_PATH = "/v1/client";

/** HTTP path a client posts its one-time pairing code to. */
export const PAIR_PATH = "/v1/pair";

/**
 * Largest binary frame a client is assumed to handle when it does not say
 * otherwise in `hello`. Small boards receive into a fixed buffer.
 */
export const DEFAULT_MAX_FRAME_BYTES = 4096;

/** Audio a client is assumed to buffer when it does not say otherwise in `hello`. */
export const DEFAULT_AUDIO_BUFFER_MS = 2000;

export function isSupportedProtocolVersion(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= MIN_SUPPORTED_PROTOCOL_VERSION &&
    version <= PROTOCOL_VERSION
  );
}
