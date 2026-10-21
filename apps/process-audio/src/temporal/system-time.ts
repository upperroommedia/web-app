/** Source-owned wall clock. No runtime flag, caller clock, offset or renewal API.
 * Keep SDK transport deadlines independent when a fixture controls domain time. */
export function mediaWallTime(): number {
  return Date.now();
}
