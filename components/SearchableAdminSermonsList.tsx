import { FunctionComponent, ReactNode, useEffect, useState } from 'react';
import algoliasearch, { SearchClient } from 'algoliasearch';
import { InstantSearch, useInstantSearch } from 'react-instantsearch';
import { createInMemoryCache } from '@algolia/cache-in-memory';
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
import { StackProps } from '@mui/system/Stack';
interface SearchableAdminSermonListProps {}

const SearchableAdminSermonList: FunctionComponent<SearchableAdminSermonListProps> = () => {
  const { user } = useAuth();
  const [searchClient, setSearchClient] = useState<SearchClient | null>(null);
  const [showFilters, setShowFilters] = useState<boolean>(false);
  if (!user) {
    throw new Error('User not found');
  }
  if (!user.role || user.role === 'user') {
    throw new Error('User is not an admin or uploader');
  }

  useEffect(() => {
    const init = async () => {
      if (!searchClient) {
        if (!process.env.NEXT_PUBLIC_ALGOLIA_APP_ID || !process.env.NEXT_PUBLIC_ALGOLIA_API_KEY) {
          throw new Error('Missing Algolia Credentials');
        }
        const generateSecuredApiKey = createFunction<GenerateSecuredApiKeyInputType, GenerateSecuredApiKeyOutputType>(
          'generatesecuredapikey'
        );
        const publicKey = user.isAdmin()
          ? process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
          : await generateSecuredApiKey({ userId: user.uid });
        setSearchClient(
          algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, publicKey, {
            responsesCache: createInMemoryCache(),
            requestsCache: createInMemoryCache({ serializable: false }),
          })
        );
      }
    };
    init();
  }, [searchClient, user, user.uid]);

  const FilterButton = () => (
    <IconButton onClick={() => setShowFilters((prev) => !prev)} sx={{ display: { xs: 'block', md: 'none' } }}>
      <FilterIcon />
    </IconButton>
  );

  const Filters = (props: StackProps) => (
    <Stack flex={1} alignItems="center" overflow="auto" {...props}>
      <Stack gap={2} alignItems="start" border={{ xs: 1, md: 0 }} borderRadius={2} p={2} margin={2}>
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

  return (
    <>
      {searchClient ? (
        <InstantSearch searchClient={searchClient} indexName="sermons" future={{ preserveSharedStateOnUnmount: true }}>
          <Stack justifyContent="center" alignItems="center" gap={2}>
            <CustomSearchBox TextFieldEndAdornment={<FilterButton />} />
            <NoResultsBoundary fallback={<NoResults />}>
              <Box
                display="grid"
                gridTemplateAreas={{ xs: `"filters" "results"`, md: `"results filters"` }}
                gridTemplateColumns={{ xs: '1fr', md: '1fr 300px' }}
                width={1}
                // sx={{ flexDirection: { xs: 'column' } }}
              >
                <SearchResultSermonList gridArea="results" />
                <Filters sx={{ display: { xs: 'none', md: 'block' } }} />
                <Stack sx={{ display: { xs: 'block', md: 'none' } }}>
                  <AnimateHeight duration={250} height={showFilters ? 'auto' : 0} style={{ gridArea: 'filters' }}>
                    <Filters />
                  </AnimateHeight>
                </Stack>
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
