import { FunctionComponent, ReactNode, useCallback, useState, type JSX } from 'react';
import { Configure, InstantSearch, useInstantSearch } from 'react-instantsearch';
import Stack from '@mui/material/Stack';
import CustomPagination from './algoliaComponents/CustomPagination';
import SearchResultSermonList from './SearchResultSermonsList';
import CustomSearchBox from './algoliaComponents/CustomSearchBox';
import Box from '@mui/material/Box';
import CustomRefinementList from './algoliaComponents/CustomRefinementList';
import useAuth from '../context/user/UserContext';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import FilterIcon from '@mui/icons-material/FilterAlt';
import AnimateHeight from 'react-animate-height';
import { SxProps, Theme } from '@mui/system';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useAlgoliaSearch } from '../context/search/AlgoliaSearchContext';

function FilterButton({ onToggle }: { onToggle: () => void }) {
  return (
    <IconButton onClick={onToggle} sx={{ display: { xs: 'block', md: 'none' } }} aria-label="Toggle filters">
      <FilterIcon />
    </IconButton>
  );
}

function AdminSermonFilters({ sx }: { sx?: SxProps<Theme> }) {
  return (
    <Stack
      sx={{
        flex: 1,
        minWidth: 0,
        width: '100%',
        alignItems: 'stretch',
        px: { xs: 1, md: 0 },
        position: { md: 'sticky' },
        top: { md: 16 },
        alignSelf: { md: 'start' },
        ...sx,
      }}
    >
      <Stack
        gap={{ xs: 1.5, md: 2 }}
        alignItems="start"
        border={{ xs: 1, md: 0 }}
        borderRadius={1}
        p={{ xs: 1.5, md: 2 }}
        width="100%"
        minWidth={0}
        boxSizing="border-box"
      >
        <CustomRefinementList attribute="status.subsplash" title="Subsplash Status" />
        <CustomRefinementList attribute="status.soundCloud" title="SoundCloud Status" />
        <CustomRefinementList
          attribute="speakers.name"
          limit={5}
          showMore={true}
          showMoreLimit={25}
          searchable
          searchablePlaceholder="Search Speakers"
          sortBy={['isRefined:desc', 'count:desc', 'name:asc']}
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

const SearchableAdminSermonList: FunctionComponent<{ refreshNonce?: number }> = ({ refreshNonce = 0 }) => {
  const { user } = useAuth();
  const { searchClient, loading: searchClientLoading, error: searchClientError } = useAlgoliaSearch();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [showFilters, setShowFilters] = useState<boolean>(false);

  if (!user) {
    throw new Error('User not found');
  }
  if (!user.role || user.role === 'user') {
    throw new Error('User is not an admin or uploader');
  }

  const handleFilterToggle = useCallback(() => setShowFilters((prev) => !prev), []);

  return (
    <>
      {searchClient ? (
        <InstantSearch
          key={refreshNonce}
          searchClient={searchClient}
          indexName="sermons"
          stalledSearchDelay={400}
          future={{ preserveSharedStateOnUnmount: true }}
        >
          <Configure maxValuesPerFacet={1000} />
          <Stack justifyContent="center" alignItems="center" gap={{ xs: 0.5, sm: 1 }}>
            <MobileFilterSection onToggle={handleFilterToggle} />
            <NoResultsBoundary fallback={<NoResults />}>
              <Box
                display="grid"
                gridTemplateAreas={{ xs: `"filters" "results"`, md: `"results filters"` }}
                gridTemplateColumns={{ xs: '1fr', md: '1fr 300px' }}
                width={1}
                minWidth={0}
                columnGap={{ md: 1 }}
              >
                <SearchResultSermonList gridArea="results" />
                {isMobile ? <MobileFilterDrawer show={showFilters} /> : <AdminSermonFilters />}
              </Box>
              <CustomPagination />
            </NoResultsBoundary>
          </Stack>
        </InstantSearch>
      ) : (
        <Stack margin={3} width={1} display="flex" justifyContent="center" alignItems="center">
          <Typography variant="h6">{searchClientError ? 'Search unavailable' : 'Loading'}</Typography>
          {searchClientError ? (
            <Typography color="error">{searchClientError}</Typography>
          ) : searchClientLoading ? (
            <CircularProgress />
          ) : null}
        </Stack>
      )}
    </>
  );
};

function NoResultsBoundary({ children, fallback }: { children: ReactNode; fallback: JSX.Element }) {
  const { results, indexUiState } = useInstantSearch();

  if (!results.__isArtificial && results.nbHits === 0 && indexUiState.query) {
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
