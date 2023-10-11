import { FunctionComponent, ReactNode } from 'react';
import algoliasearch from 'algoliasearch/lite';
import { InstantSearch, useInstantSearch } from 'react-instantsearch';
import { createInMemoryCache } from '@algolia/cache-in-memory';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import CustomPagination from './algoliaComponents/CustomPagination';
import SearchResultSermonList from './SearchResultSermonsList';
import CustomSearchBox from './algoliaComponents/CustomSearchBox';
interface SearchableAdminSermonListProps {}

const searchClient =
  process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
    ? algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY, {
        responsesCache: createInMemoryCache(),
        requestsCache: createInMemoryCache({ serializable: false }),
      })
    : undefined;

const SearchableAdminSermonList: FunctionComponent<SearchableAdminSermonListProps> = () => {
  return searchClient ? (
    <InstantSearch searchClient={searchClient} indexName="sermons">
      <Stack justifyContent="center" alignItems="center">
        <CustomSearchBox />
        <NoResultsBoundary fallback={<NoResults />}>
          <SearchResultSermonList />
          <CustomPagination />
        </NoResultsBoundary>
      </Stack>
    </InstantSearch>
  ) : (
    <Typography>Missing Algolia Credentials</Typography>
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
        <div hidden>{children}</div>
      </>
    );
  }

  return <>{children}</>;
}

function NoResults() {
  const { indexUiState } = useInstantSearch();

  return (
    <div>
      <p>
        No results for <q>{indexUiState.query}</q>.
      </p>
    </div>
  );
}

export default SearchableAdminSermonList;
