export type ProcessAudioFailureHandlingOutcome = 'deferred' | 'post_live_retry' | 'unhandled';

export function shouldCaptureProcessAudioFailure(args: {
  outcome: ProcessAudioFailureHandlingOutcome;
  shouldAlert?: boolean;
}): boolean {
  if (args.outcome === 'unhandled') return true;
  if (args.outcome === 'post_live_retry') return false;

  return args.shouldAlert === true;
}
