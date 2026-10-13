import type { WorkflowInterceptors } from '@temporalio/workflow';
/** Native history-rotation test keeps real activity/continuation commands; polling delays use an immediate test clock. */
export const interceptors = (): WorkflowInterceptors => ({
  outbound: [{ startTimer: (input, next) => (input.durationMs === 30000 ? Promise.resolve() : next(input)) }],
});
