/** Labels are display hints, never identity or provider payload. Unsafe titles simply omit the hint. */
export function entityLabel(value: unknown): { label?: string } {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(value) ||
    /(?:bearer\s|-----BEGIN|\beyJ[A-Za-z0-9_-]{12,}\.|[?&](?:token|key|signature)=)/i.test(value)
  )
    return {};
  return { label: value.trim().slice(0, 200) };
}
