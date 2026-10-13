import { BlockList, isIP } from 'node:net';
import ranges = require('./public-address-ranges.json');

// Conservative public unicast policy: exclude special-purpose/transition ranges
// from IANA registries plus multicast/reserved IPv4; parse with Node's native IP implementation.
const excluded = new BlockList(),
  globalV6 = new BlockList();
for (const [cidrs, family] of [
  [ranges.ipv4Excluded, 'ipv4'],
  [ranges.ipv6Excluded, 'ipv6'],
] as const)
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split('/');
    excluded.addSubnet(address, Number(prefix), family);
  }
const [address, prefix] = ranges.ipv6Global.split('/');
globalV6.addSubnet(address, Number(prefix), 'ipv6');
export function isPublicEmailAddress(value: string): boolean {
  const family = isIP(value);
  return family === 4
    ? !excluded.check(value, 'ipv4')
    : family === 6 && globalV6.check(value, 'ipv6') && !excluded.check(value, 'ipv6');
}
