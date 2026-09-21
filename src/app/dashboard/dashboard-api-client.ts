export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function readJsonObject(
  response: Response,
  description: string,
): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isJsonObject(value)) {
    throw new Error(`The local server returned invalid ${description}.`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
