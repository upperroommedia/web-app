import { FunctionComponent, ReactNode, useCallback, useEffect, useState, useMemo, type JSX } from 'react';
import { algoliasearch, SearchClient } from 'algoliasearch';
import { InstantSearch, useInstantSearch } from 'react-instantsearch';
import Stack from '@mui/material/Stack';
import CustomPagination from './algoliaComponents/CustomPagination';
import SearchResultSermonList from './SearchResultSermonsList';
import CustomSearchBox from './algoliaComponents/CustomSearchBox';
import Box from '@mui/material/Box';
import CustomRefinementList from './algoliaComponents/CustomRefinementList';
import useAuth from '../context/user/UserContext';
import {
  GenerateSecuredApiKeyInputType,
  GenerateSecuredApiKeyOutputType,
} from '../functions/src/generateAlgoliaSecureApiKey';
import { createFunction } from '../utils/createFunction';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import FilterIcon from '@mui/icons-material/FilterAlt';
import AnimateHeight from 'react-animate-height';
import { SxProps, Theme } from '@mui/system';
import { isDevelopment } from '../firebase/firebase';
import { createMockAlgoliaSearchClient } from '../utils/mockAlgoliaSearchClient';

interface SearchableAdminSermonListProps {}

function FilterButton({ onToggle }: { onToggle: () => void }) {
  return (
    <IconButton onClick={onToggle} sx={{ display: { xs: 'block', md: 'none' } }} aria-label="Toggle filters">
      <FilterIcon />
    </IconButton>
  );
}

function AdminSermonFilters({ sx }: { sx?: SxProps<Theme> }) {
  return (
    <Stack sx={{ flex: 1, alignItems: 'center', overflow: 'auto', ...sx }}>
      <Stack
        gap={{ xs: 1.5, md: 2 }}
        alignItems="start"
        border={{ xs: 1, md: 0 }}
        borderRadius={2}
        p={{ xs: 1.5, md: 2 }}
        margin={{ xs: 1, md: 2 }}
        width={{ xs: '100%', md: 'auto' }}
      >
        <CustomRefinementList attribute="status.subsplash" title="Subsplash Status" />
        <CustomRefinementList attribute="status.soundCloud" title="SoundCloud Status" />
        <CustomRefinementList
          attribute="speakers.name"
          limit={5}
          showMore={true}
          searchable
          searchablePlaceholder="Search Speakers"
          title="Speakers"
        />
      </Stack>
    </Stack>
  );
}

function MobileFilterSection({ onToggle }: { onToggle: () => void }) {
  return <CustomSearchBox TextFieldEndAdornment={<FilterButton onToggle={onToggle} />} />;
}

function MobileFilterDrawer({ show }: { show: boolean }) {
  return (
    <Stack sx={{ display: { xs: 'block', md: 'none' } }} style={{ gridArea: 'filters' }}>
      <AnimateHeight duration={250} height={show ? 'auto' : 0}>
        <AdminSermonFilters />
      </AnimateHeight>
    </Stack>
  );
}

const SearchableAdminSermonList: FunctionComponent<SearchableAdminSermonListProps> = () => {
  const { user } = useAuth();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState<boolean>(false);

  if (!user) {
    throw new Error('User not found');
  }
  if (!user.role || user.role === 'user') {
    throw new Error('User is not an admin or uploader');
  }

  useEffect(() => {
    const initApiKey = async () => {
      if (!apiKey) {
        if (isDevelopment) {
          setApiKey('mock-key');
          return;
        }
        if (!process.env.NEXT_PUBLIC_ALGOLIA_APP_ID || !process.env.NEXT_PUBLIC_ALGOLIA_API_KEY) {
          throw new Error('Missing Algolia Credentials');
        }
        if (user.isAdmin()) {
          setApiKey(process.env.NEXT_PUBLIC_ALGOLIA_API_KEY);
        } else {
          const generateSecuredApiKey = createFunction<GenerateSecuredApiKeyInputType, GenerateSecuredApiKeyOutputType>(
            'generatesecuredapikey'
          );
          const securedKey = await generateSecuredApiKey({ userId: user.uid });
          setApiKey(securedKey);
        }
      }
    };
    initApiKey();
  }, [apiKey, user]);

  const searchClient = useMemo((): SearchClient | null => {
    if (isDevelopment) {
      return createMockAlgoliaSearchClient({
        userId: user.uid,
        isAdmin: user.isAdmin(),
      });
    }
    if (!apiKey || !process.env.NEXT_PUBLIC_ALGOLIA_APP_ID) {
      return null;
    }
    return algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, apiKey);
  }, [apiKey, user]);

  const handleFilterToggle = useCallback(() => setShowFilters((prev) => !prev), []);

  return (
    <>
      {searchClient ? (
        <InstantSearch searchClient={searchClient} indexName="sermons" future={{ preserveSharedStateOnUnmount: true }}>
          <Stack justifyContent="center" alignItems="center" gap={{ xs: 0.5, sm: 1 }}>
            <MobileFilterSection onToggle={handleFilterToggle} />
            <NoResultsBoundary fallback={<NoResults />}>
              <Box
                display="grid"
                gridTemplateAreas={{ xs: `"filters" "results"`, md: `"results filters"` }}
                gridTemplateColumns={{ xs: '1fr', md: '1fr 300px' }}
                width={1}
              >
                <SearchResultSermonList gridArea="results" />
                <AdminSermonFilters sx={{ display: { xs: 'none', md: 'block' } }} />
                <MobileFilterDrawer show={showFilters} />
              </Box>
              <CustomPagination />
            </NoResultsBoundary>
          </Stack>
        </InstantSearch>
      ) : (
        <Stack margin={3} width={1} display="flex" justifyContent="center" alignItems="center">
          <Typography variant="h6">Loading</Typography>
          <CircularProgress />
        </Stack>
      )}
    </>
  );
};

function NoResultsBoundary({ children, fallback }: { children: ReactNode; fallback: JSX.Element }) {
  const { results } = useInstantSearch();

  // The `__isArtificial` flag makes sure not to display the No Results message
  // when no hits have been returned.
  if (!results.__isArtificial && results.nbHits === 0) {
    return (
      <>
        {fallback}
        <Box hidden>{children}</Box>
      </>
    );
  }

  return <>{children}</>;
}

function NoResults() {
  const { indexUiState } = useInstantSearch();

  return (
    <Box m={2}>
      <Typography>
        {indexUiState.query
          ? `No results for "${indexUiState.query}".`
          : 'No sermons found - please upload one from the Uploader tab'}
      </Typography>
    </Box>
  );
}

export default SearchableAdminSermonList;
