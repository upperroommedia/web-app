import { prepareStopCloudRunDispatchWake } from './temporal-prepare-stop-dispatch-wake.mjs';
export async function prepareStopCloudRunEventarc(options) {
  if (!['outbox-trigger', 'commands-trigger'].includes(options?.surface)) throw new Error('EVENTARC_CYCLE_SURFACE_REQUIRED');
  return prepareStopCloudRunDispatchWake(options);
}
