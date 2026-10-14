/** Read-only, authenticated server authority. A browser flag never enables simulation. */
export type ProviderSandboxStatus =
  | { mode: 'live'; ready: true; catalogReady: false; scenarioSelectionAllowed: false }
  | {
      mode: 'sandbox';
      ready: true;
      catalogReady: true;
      profileId: string;
      version: 1;
      scenarioSelectionAllowed: boolean;
    }
  | {
      mode: 'blocked';
      ready: false;
      catalogReady: false;
      scenarioSelectionAllowed: false;
      reason: 'configuration-unavailable' | 'catalog-not-ready';
    };

export interface ProviderSandboxResourceSummary {
  provider: 'subsplash' | 'soundcloud';
  family: string;
  id: string;
  title?: string;
  deleted: boolean;
  readyAtMillis?: number;
}
export interface ProviderSandboxRequestSummary {
  provider: 'subsplash' | 'soundcloud';
  method: string;
  outcome: string;
  fault: import('./temporal').ProviderSimulationScenario;
  atMillis: number;
  resourceRefs: ProviderSandboxResourceSummary[];
}
/** Explicit allowlist: no raw request paths, resource bodies, URLs or credentials. */
export interface ProviderSandboxJobInspection {
  profileId: string;
  jobId: string;
  providerExecution: import('./temporal').ProviderExecution;
  observedAtMillis: number;
  requests: ProviderSandboxRequestSummary[];
  resources: ProviderSandboxResourceSummary[];
  truncated: { requests: boolean; resources: boolean };
}
