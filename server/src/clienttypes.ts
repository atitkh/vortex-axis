/**
 * Client types that were renamed: the old name, as a device that has not updated yet still says it when it pairs
 * or says hello, and the new one. The one place an old name is mapped. `Store` renames what it keeps under an old
 * name when it opens (clients, the type layer of settings, what the type described, its label) and pairs a device
 * that gives an old name under the new one; a hello's type is never used (the stored record's type wins).
 */
export const RENAMED_TYPES: Readonly<Record<string, string>> = {
  // The Quest panel client 0.1.0 and 0.2.0 (Axis 0.43.x and before); 0.3.0 says meta-quest.
  "quest-panels": "meta-quest",
};

/** A client type by its current name. */
export function currentType(type: string): string {
  return Object.hasOwn(RENAMED_TYPES, type) ? RENAMED_TYPES[type]! : type;
}
