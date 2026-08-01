import { AppError } from "../errors.js";

function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Evidence contains a non-finite number.",
      );
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => serialize(entry)).join(",")}]`;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Evidence contains an unsupported object type.",
      );
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const entry = record[key];
        if (entry === undefined) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Evidence contains an undefined value.",
          );
        }
        return `${JSON.stringify(key)}:${serialize(entry)}`;
      });
    return `{${entries.join(",")}}`;
  }

  throw new AppError(
    "INTERNAL_ERROR",
    "Evidence contains an unsupported value.",
  );
}

export function canonicalJson(value: unknown): string {
  return serialize(value);
}
