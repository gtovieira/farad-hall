# Hall protocol v1

The contract between Farad Hall and the Orquestra's `hall-agent`. The Orquestra vendors this
directory as it is; its CI checks that the copy matches the version it implements.

| File | What |
|---|---|
| `openapi.json` | OpenAPI 3.1: the four device operations, their headers, bodies and answers |
| `schemas/*.schema.json` | One JSON Schema (draft 2020-12) per message, self-contained |
| `test-vectors.json` | A fixed key and requests with their canonical strings and signatures |

Generated from `packages/protocol` (zod schemas) by `pnpm --filter @hall/protocol generate`. Do not
edit by hand.

## Messages

All are `POST`, JSON (`Content-Type: application/json`), at most 1 MiB, signed (below).

| Path | Body | Answer | When |
|---|---|---|---|
| `/api/device/enrol` | `EnrolRequest`: claim code, public key, device info | 201 `EnrolResponse`: `deviceId`, site, customer, intervals | once |
| `/api/device/heartbeat` | `Heartbeat`: version, uptime, LAN IP, image digest | 200 `Ack` with the public IP Hall saw | every `intervals.heartbeatS` (60 s) |
| `/api/device/state` | `DeviceState`: services, CPU/mem/disk/temperature, control mode, chargers | 200 `Ack` | every `intervals.stateS` (300 s) and at once on a control mode change |
| `/api/device/events` | `EventBatch`: up to 500 warning/critical events | 200 `Ack` with accepted/duplicates | as they happen; a batch may be resent (dedup by event `id`) |

- Every body carries `protocolVersion: 1`. Hall reads it first and answers 422
  `unsupported-protocol` with `supportedVersions` when it does not accept it. Hall accepts the
  current version and the one before, so a fleet can update gradually.
- Unknown fields are ignored on both sides. Enums are closed within a version.
- Anything but a 2xx means the message was not stored: keep it in the local queue and send it again
  later (with a new nonce and timestamp). A 403 `device-revoked` means stop.
- Errors are `DeviceError`: `{ error, message, hint?, serverTime?, supportedVersions?, issues? }`.

## Identity

1. On first start, the agent generates an **Ed25519** key pair and keeps the private key on the
   device (mode 0600). It is never sent anywhere.
2. An admin creates a **claim code** in Hall for a site (8 characters, e.g. `K7QM-4TZP`, single use,
   24 h). The installer types it into the Orquestra.
3. The agent sends `POST /api/device/enrol` with the code and its public key (the 32 raw bytes,
   base64url without padding), signed with the new private key. Hall answers the `deviceId`.
4. Every later request is signed with the same key and carries `Hall-Device: <deviceId>`.

## Signing a request

The agent signs the UTF-8 bytes of this string, lines joined by `\n` (no trailing newline):

```
HALL-ED25519-V1
<METHOD, upper case>
<path and query, exactly as sent, e.g. /api/device/heartbeat>
<Hall-Timestamp: unix seconds>
<Hall-Nonce>
<SHA-256 of the exact body bytes, lower-case hex>
<Hall-Device, or the word enrol on the enrolment request>
```

and sends:

| Header | Value |
|---|---|
| `Hall-Device` | the `deviceId` (not on enrolment) |
| `Hall-Timestamp` | unix seconds, from a clock within **300 s** of Hall's |
| `Hall-Nonce` | 16–128 characters of `A–Z a–z 0–9 _ -`, new for every request (128 random bits, base64url) |
| `Hall-Signature` | the 64-byte Ed25519 signature, base64url without padding |

Hall refuses (401) a missing or wrong signature (`bad-signature`), a timestamp outside the window
(`stale-timestamp`, with Hall's `serverTime`: correct the clock offset and resend), and a nonce it
has seen from that device in the last 600 s (`replayed-nonce`). Every `Ack` carries Hall's
`receivedAt`, which the agent can use to keep its offset.

Check an implementation against `test-vectors.json`: the seed is RFC 8032's first test key, and
Ed25519 is deterministic, so the signatures must match byte for byte.
