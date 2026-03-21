import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { SearchClient } from 'algoliasearch';
import { algoliasearch } from 'algoliasearch';
import useAuth from '../user/UserContext';
import { createFunction } from '../../utils/createFunction';
import type {
  GenerateSecuredApiKeyInputType,
  GenerateSecuredApiKeyOutputType,
} from '@upperroom/contracts/generateAlgoliaSecureApiKey';
import { isDevelopment } from '../../firebase/firebase';
import { createMockAlgoliaSearchClient } from '../../utils/mockAlgoliaSearchClient';

type AlgoliaSearchContextValue = {
  appId: string | null;
  searchClient: SearchClient | null;
  loading: boolean;
  error: string | null;
  clearCache: () => Promise<void>;
};

const AlgoliaSearchContext = createContext<AlgoliaSearchContextValue | null>(null);

const clientCache = new Map<string, SearchClient>();

const getClientKey = (appId: string, apiKey: string) => `${appId}:${apiKey}`;

const getOrCreateSearchClient = (appId: string, apiKey: string): SearchClient => {
  const cacheKey = getClientKey(appId, apiKey);
  const cachedClient = clientCache.get(cacheKey);
  if (cachedClient) {
    return cachedClient;
  }

  const nextClient = algoliasearch(appId, apiKey);
  clientCache.set(cacheKey, nextClient);
  return nextClient;
};

export const AlgoliaSearchProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const appId = process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? null;
  const adminApiKey = process.env.NEXT_PUBLIC_ALGOLIA_API_KEY ?? null;
  const [apiKey, setApiKey] = useState<string | null>(adminApiKey);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const initSearchKey = async () => {
      if (!appId || !user) {
        setApiKey(adminApiKey);
        setLoading(false);
        setError(null);
        return;
      }

      if (user.isAdmin()) {
        setApiKey(adminApiKey);
        setLoading(false);
        setError(null);
        return;
      }

      if (!user.canUpload()) {
        setApiKey(null);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const generateSecuredApiKey = createFunction<
          GenerateSecuredApiKeyInputType,
          GenerateSecuredApiKeyOutputType
        >('generatesecuredapikey');
        const securedKey = await generateSecuredApiKey({ userId: user.uid });
        if (!cancelled) {
          setApiKey(securedKey);
        }
      } catch (initError) {
        if (!cancelled) {
          setApiKey(null);
          setError(initError instanceof Error ? initError.message : 'Failed to initialize Algolia search.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void initSearchKey();

    return () => {
      cancelled = true;
    };
  }, [adminApiKey, appId, user]);

  const searchClient = useMemo(() => {
    if (isDevelopment && user) {
      return createMockAlgoliaSearchClient({
        userId: user.uid,
        canSearchAllSermons: user.isAdmin(),
      });
    }

    if (!appId || !apiKey) {
      return null;
    }

    return getOrCreateSearchClient(appId, apiKey);
  }, [apiKey, appId, user]);

  const clearCache = useCallback(async () => {
    if (!searchClient || !('clearCache' in searchClient) || typeof searchClient.clearCache !== 'function') {
      return;
    }

    await searchClient.clearCache();
  }, [searchClient]);

  const value = useMemo<AlgoliaSearchContextValue>(
    () => ({
      appId,
      searchClient,
      loading,
      error,
      clearCache,
    }),
    [appId, clearCache, error, loading, searchClient]
  );

  return <AlgoliaSearchContext.Provider value={value}>{children}</AlgoliaSearchContext.Provider>;
};

export const useAlgoliaSearch = (): AlgoliaSearchContextValue => {
  const context = useContext(AlgoliaSearchContext);

  if (!context) {
    throw new Error('useAlgoliaSearch must be used within an AlgoliaSearchProvider');
  }

  return context;
};
