/** ws message payload decoding shared by the Node client and the host relay. */

/**
 * ws delivers text frames as strings or Buffers depending on the peer;
 * normalize to a string, or undefined for binary/unrecognized payloads.
 */
export function decodeWsText(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data) && data.every(part => Buffer.isBuffer(part))) {
    return Buffer.concat(data).toString('utf8')
  }
  return undefined
}
