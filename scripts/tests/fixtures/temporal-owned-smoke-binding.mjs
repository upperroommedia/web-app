// Synthetic database fixture matching the safe original binding profile. No credentials or transport.
export function ownedBindingFixture(incident) {
  const bindingId = incident.preservedProviderBinding.bindingId;
  const virtual = `providerBindings/${incident.publicationJobId}/${bindingId}`;
  const actual = `temporalPublishingProviderBindings/${incident.publicationJobId}/bindings/${bindingId}`;
  const data = {
    ...incident.resources[1],
    jobId: incident.publicationJobId,
    bindingId,
    state: 'reserved',
    target: { provider: 'subsplash', kind: 'list', remoteId: incident.listIds[0] },
    createdAtMillis: 1792199203393,
  };
  const edge = {
    projectId: incident.projectId,
    canonicalPath: virtual,
    jobId: incident.publicationJobId,
    bindingId,
    state: 'pending_effect',
  };
  return { bindingId, virtual, actual, data, edge };
}
