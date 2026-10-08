// Writes the protocol as one JSON Schema file, for firmware and other
// non-TypeScript clients to validate against.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLIENT_MESSAGE_SCHEMAS,
  SERVER_MESSAGE_SCHEMAS,
  PairRequest,
  PairResponse,
} from "./messages.js";
import { PROTOCOL_VERSION } from "./version.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "schema", `axis-protocol.v${PROTOCOL_VERSION}.json`);

const byType = (schemas: readonly { $id?: string }[]) =>
  Object.fromEntries(schemas.map((schema) => [schema.$id as string, schema]));

const document = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "VorteX Axis client protocol",
  protocolVersion: PROTOCOL_VERSION,
  clientToAxis: byType(CLIENT_MESSAGE_SCHEMAS),
  axisToClient: byType(SERVER_MESSAGE_SCHEMAS),
  http: { PairRequest, PairResponse },
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${out}`);
