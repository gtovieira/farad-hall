// The files of protocol/v<N>/: the OpenAPI document, one JSON Schema per message, the signature
// test vectors. Written by src/generate.ts; the tests check the committed ones are these.
import { jsonSchemaOf, stringify } from '@hall/openapi';
import { PROTOCOL_SCHEMA_FILES, protocolDocument } from './document.js';
import { DEVICE_PATHS } from './paths.js';
import { canonicalString, ENROL_KEY_ID, privateKeyFromSeed, rawPublicKey, sha256Hex, signRequest, type SignedParts } from './signing.js';
import { CURRENT_PROTOCOL_VERSION } from './versions.js';

/** Fixed inputs, so another implementation (the hall-agent) can check its signing byte for byte. */
export function testVectors() {
  const seedHex = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
  const key = privateKeyFromSeed(Buffer.from(seedHex, 'hex'));
  const publicKey = rawPublicKey(key);
  const cases: { name: string; parts: SignedParts }[] = [
    {
      name: 'heartbeat',
      parts: {
        method: 'POST',
        path: DEVICE_PATHS.heartbeat,
        timestamp: 1762783200,
        nonce: 'q8Xl2oQ0b8v4cJmN1rT6wA',
        keyId: '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b',
        body: '{"protocolVersion":1,"sentAt":"2026-11-10T14:00:00.000Z","version":"v1.4.0","uptimeS":5123}',
      },
    },
    {
      name: 'enrol',
      parts: {
        method: 'POST',
        path: DEVICE_PATHS.enrol,
        timestamp: 1762783200,
        nonce: 'Zm9vYmFyYmF6cXV4MTIzNA',
        keyId: ENROL_KEY_ID,
        body: `{"protocolVersion":1,"claimCode":"K7QM-4TZP","publicKey":"${publicKey}","device":{"orquestraVersion":"v1.4.0"}}`,
      },
    },
  ];
  return {
    description:
      'Ed25519 signing test vectors for the Hall protocol. privateKeySeedHex is the 32-byte seed (RFC 8032 test 1). ' +
      'Each case: sign canonicalString (UTF-8) and compare with headers["hall-signature"].',
    scheme: 'HALL-ED25519-V1',
    privateKeySeedHex: seedHex,
    publicKey,
    cases: cases.map(({ name, parts }) => ({
      name,
      method: parts.method,
      path: parts.path,
      timestamp: parts.timestamp,
      nonce: parts.nonce,
      keyId: parts.keyId,
      body: parts.body as string,
      bodySha256: sha256Hex(parts.body),
      canonicalString: canonicalString(parts),
      headers: signRequest(key, parts),
    })),
  };
}

/** protocol/v<N>/ file path → contents. */
export function protocolFiles(): Record<string, string> {
  const dir = `protocol/v${CURRENT_PROTOCOL_VERSION}`;
  const files: Record<string, string> = {
    [`${dir}/openapi.json`]: stringify(protocolDocument()),
    [`${dir}/test-vectors.json`]: stringify(testVectors()),
  };
  for (const [name, schema] of Object.entries(PROTOCOL_SCHEMA_FILES)) {
    const answer = /response|ack|error/.test(name);
    files[`${dir}/schemas/${name}`] = stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `urn:farad:hall:protocol:v${CURRENT_PROTOCOL_VERSION}:${name.replace('.schema.json', '')}`,
      title: name.replace('.schema.json', ''),
      ...jsonSchemaOf(schema, answer ? 'output' : 'input'),
    });
  }
  return files;
}
