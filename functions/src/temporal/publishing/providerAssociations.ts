import { reserveDurableProviderBindings, type DurableProviderBindingResource } from './durableOperationContext';
import { providerPayloadFingerprint } from './providerReceipts';
export type SubsplashAssociationTarget = {
  provider: 'subsplash';
  kind: 'media-item' | 'series' | 'list' | 'tag' | 'transcode';
  remoteId: string;
};
/** Callers supply only IDs from the actual provider payload, never canonical local ImageType/ISpeaker IDs. */
export async function reserveSubsplashAssociation(
  association: string,
  remoteIds: readonly (string | undefined | null)[],
  body: unknown,
  options: { target?: SubsplashAssociationTarget; targetReceiptId?: string } = {}
): Promise<void> {
  const resources: DurableProviderBindingResource[] = [
    ...new Set(remoteIds.filter((id): id is string => typeof id === 'string' && !!id)),
  ].map((remoteId) => ({ provider: 'subsplash', account: 'app:9XTSHD', remoteId }));
  if (!resources.length) return;
  await reserveDurableProviderBindings(resources, `${association}:${providerPayloadFingerprint(body)}`, options);
}
