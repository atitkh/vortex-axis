import type { TSchema } from "@sinclair/typebox";
import { TypeCompiler, type TypeCheck } from "@sinclair/typebox/compiler";
import {
  CLIENT_MESSAGE_SCHEMAS,
  SERVER_MESSAGE_SCHEMAS,
  PairRequest,
  PairResponse,
  type ClientMessage,
  type ServerMessage,
} from "./messages.js";

export type ParseResult<T> =
  | { ok: true; message: T }
  | { ok: false; error: string };

type Checkers = Map<string, TypeCheck<TSchema>>;

function compileAll(schemas: readonly TSchema[]): Checkers {
  const checkers: Checkers = new Map();
  for (const schema of schemas) {
    const t = (schema as unknown as { properties: { t: { const: string } } }).properties.t.const;
    checkers.set(t, TypeCompiler.Compile(schema));
  }
  return checkers;
}

const clientCheckers = compileAll(CLIENT_MESSAGE_SCHEMAS);
const serverCheckers = compileAll(SERVER_MESSAGE_SCHEMAS);
const pairRequestChecker = TypeCompiler.Compile(PairRequest);
const pairResponseChecker = TypeCompiler.Compile(PairResponse);

function firstError(checker: TypeCheck<TSchema>, value: unknown): string {
  const error = checker.Errors(value).First();
  if (!error) return "invalid message";
  return `${error.path || "/"}: ${error.message}`;
}

function parseWith<T>(checkers: Checkers, input: unknown): ParseResult<T> {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, error: "not valid JSON" };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "message must be a JSON object" };
  }
  const t = (value as { t?: unknown }).t;
  if (typeof t !== "string") {
    return { ok: false, error: "message has no type field `t`" };
  }
  const checker = checkers.get(t);
  if (!checker) {
    return { ok: false, error: `unknown message type "${t}"` };
  }
  if (!checker.Check(value)) {
    return { ok: false, error: `${t}: ${firstError(checker, value)}` };
  }
  return { ok: true, message: value as T };
}

/** Validates a control frame sent by a client. Accepts a JSON string or a parsed value. */
export function parseClientMessage(input: unknown): ParseResult<ClientMessage> {
  return parseWith<ClientMessage>(clientCheckers, input);
}

/** Validates a control frame sent by Axis. Accepts a JSON string or a parsed value. */
export function parseServerMessage(input: unknown): ParseResult<ServerMessage> {
  return parseWith<ServerMessage>(serverCheckers, input);
}

function encodeWith(checkers: Checkers, message: { t: string }): string {
  const t = message.t;
  const checker = checkers.get(t);
  if (!checker) throw new Error(`unknown message type "${t}"`);
  if (!checker.Check(message)) {
    throw new Error(`${t}: ${firstError(checker, message)}`);
  }
  return JSON.stringify(message);
}

/** Serializes a client message, throwing if it does not match the protocol. */
export function encodeClientMessage(message: ClientMessage): string {
  return encodeWith(clientCheckers, message);
}

/** Serializes a server message, throwing if it does not match the protocol. */
export function encodeServerMessage(message: ServerMessage): string {
  return encodeWith(serverCheckers, message);
}

export function isPairRequest(value: unknown): value is PairRequest {
  return pairRequestChecker.Check(value);
}

export function isPairResponse(value: unknown): value is PairResponse {
  return pairResponseChecker.Check(value);
}
