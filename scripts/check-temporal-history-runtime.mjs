import { createRequire } from 'node:module';

const workerRequire = createRequire(new URL('../apps/temporal-worker/package.json', import.meta.url));
const commonRequire = createRequire(workerRequire.resolve('@temporalio/common'));
const protoRequire = createRequire(commonRequire.resolve('@temporalio/proto'));

// Temporal's JSON converter requires the same protobuf Type constructor that
// created its schema. A hoisted install can otherwise give these SDK packages
// separate protobuf 8 copies while Firebase uses protobuf 7 at the root.
if (commonRequire('protobufjs').Type !== protoRequire('protobufjs').Type) {
  throw new Error('Temporal history conversion requires a shared protobufjs runtime');
}
const { historyFromJSON, historyToJSON } = commonRequire('./proto-utils');
const history = historyFromJSON({ events: [] });
// Protobuf JSON legitimately omits empty repeated fields when serializing.
if (history.events.length !== 0 || typeof historyToJSON(history) !== 'string') {
  throw new Error('Temporal JSON history conversion failed');
}
console.log('Temporal JSON history runtime verified');
