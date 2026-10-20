import { prepareStopCloudRunDispatchWake } from './temporal-prepare-stop-dispatch-wake.mjs';
/** Preserve the original Scheduler plan/receipt and canonical action boundary. */
export const prepareStopCloudRunScheduler = options => prepareStopCloudRunDispatchWake({ ...options, surface: 'scheduler' });
