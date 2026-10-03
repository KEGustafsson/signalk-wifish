// Small helpers shared by the server modules.

/** Message of a thrown value: Error.message, else its string form (a bare `throw 'x'` or `throw 42`). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e && typeof (e as { message: unknown }).message === 'string') return (e as { message: string }).message;
  return String(e);
}
