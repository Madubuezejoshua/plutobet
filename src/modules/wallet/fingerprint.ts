import { createHash } from "node:crypto";
import { InvalidMetadataError } from "./errors";
import type { JsonValue } from "./types";

function canonicalize(value: unknown, path = "metadata"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidMetadataError(`${path} contains a non-finite number`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }

  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(object).sort()) {
      const child = object[key];
      if (child === undefined) {
        throw new InvalidMetadataError(`${path}.${key} is undefined`);
      }
      output[key] = canonicalize(child, `${path}.${key}`);
    }
    return output;
  }

  throw new InvalidMetadataError(`${path} contains ${typeof value}`);
}

export function operationFingerprint(input: Record<string, unknown>): string {
  const canonical = canonicalize(input, "operation");
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
