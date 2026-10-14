/** Server-only protocol values. These types are never accepted directly from callable input. */
export type SandboxProvider = 'subsplash' | 'soundcloud';
export interface SandboxRequestContext {
  jobId: string;
  stepId?: string;
  sourceStepIds?: string[];
}
export interface StageAssetRef {
  bucket: string;
  path: string;
  generation: string;
}
export interface SandboxAssetEvidence extends StageAssetRef {
  sha256: string;
  contentType: string;
  size: number;
  durationSeconds?: number;
  preparationId?: string;
}
export interface SandboxRequest {
  provider: SandboxProvider;
  method: string;
  url: string;
  data?: unknown;
  params?: Record<string, unknown>;
  context?: SandboxRequestContext;
}
export interface SandboxResponse {
  status: number;
  data: any;
  headers: Record<string, string>;
}
export type SandboxFault =
  | 'success'
  | 'delayed-processing'
  | 'transient-failure'
  | 'permanent-failure'
  | 'commit-then-lost-response';
export interface SandboxFaultPlan {
  schemaVersion: 1;
  jobId: string;
  stepId: string;
  provider: SandboxProvider;
  method: string;
  path: string;
  fault: SandboxFault;
  remaining: number;
  delayMillis?: number;
}
export interface SandboxResource {
  schemaVersion: 1;
  provider: SandboxProvider;
  family: string;
  id: string;
  revision: number;
  deleted: boolean;
  body: Record<string, any>;
  readyAtMillis?: number;
  source?: SandboxAssetEvidence;
  origin?: SandboxAssetEvidence;
  createdAtMillis: number;
  updatedAtMillis: number;
}
export class SandboxHttpError extends Error {
  readonly isAxiosError = true;
  readonly response?: { status: number; data: { error: string }; headers: Record<string, string> };
  readonly code: string;
  constructor(status: number | undefined, message: string, code = 'PROVIDER_SANDBOX_ERROR') {
    super(message);
    this.name = 'SandboxHttpError';
    this.code = code;
    if (status !== undefined) this.response = { status, data: { error: message }, headers: {} };
  }
}

/** Only the atomically consumed, server-pinned scenario path constructs this type. */
export class SandboxScriptedFault extends SandboxHttpError {
  readonly sandboxScriptedFault = true;
  constructor(status: number | undefined, readonly scenario: SandboxFault, message: string, code?: string) {
    super(status, message, code);
    this.name = 'SandboxScriptedFault';
  }
}

export interface SandboxInspectedResource {
  provider: SandboxProvider;
  family: string;
  id: string;
  title?: string;
  deleted: boolean;
  readyAtMillis?: number;
}
export interface SandboxJobInspection {
  profileId: string;
  jobId: string;
  providerExecution: import('@upperroom/contracts/temporal').ProviderExecution;
  requests: Array<{
    provider: SandboxProvider;
    method: string;
    atMillis: number;
    outcome: string;
    fault: SandboxFault;
    resourceRefs: SandboxInspectedResource[];
  }>;
  resources: SandboxInspectedResource[];
  truncated: { requests: boolean; resources: boolean };
}
