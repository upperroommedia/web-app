import Typography from '@mui/material/Typography';
import Box from '@mui/system/Box';
import firestore, { collection, limit, orderBy, query, where } from '../firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import SermonsList from './SermonsList';
import { sermonConverter } from '../types/Sermon';
import SermonListSkeloten from './skeletons/SermonListSkeloten';
import { FunctionComponent, useState } from 'react';
// import TextField from '@mui/material/TextField';
// import FormControl from '@mui/material/FormControl';
// import InputLabel from '@mui/material/InputLabel';
// import Select from '@mui/material/Select';
// import MenuItem from '@mui/material/MenuItem';
import { Sermon } from '../types/SermonTypes';
// import algoliasearch from 'algoliasearch';
// import { createInMemoryCache } from '@algolia/cache-in-memory';
// import Checkbox from '@mui/material/Checkbox';
// import ListItemText from '@mui/material/ListItemText';
import { User, UserRole } from '../types/User';
import Button from '@mui/material/Button';
import UserRoleGuard from './UserRoleGuard';
import Link from '@mui/material/Link';

interface AdminSermonsListProps {
  collectionPath: string;
  count?: number;
}

interface AdminSermonsListWithUserProps extends AdminSermonsListProps {
  user: User;
}

const HITSPERPAGE = 20;

// const client =
//   process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
//     ? algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY, {
//         responsesCache: createInMemoryCache(),
//         requestsCache: createInMemoryCache({ serializable: false }),
//       })
//     : undefined;
// const sermonsIndex = client?.initIndex('sermons');

const AdminSermonsListWithUser: FunctionComponent<AdminSermonsListWithUserProps> = ({
  collectionPath,
  count,
  user,
}) => {
  const [queryLimit, setQueryLimit] = useState<number>(HITSPERPAGE);
  const [previousSermonsCount, setPreviousSermonsCount] = useState<number>(0);
  const [previousSermons, setPreviousSermons] = useState<Sermon[]>([]);
  // const [algoliaLoading, setAlgoliaLoading] = useState(false);

  const sermonsRef = collection(firestore, collectionPath);
  const q =
    user.role !== UserRole.ADMIN
      ? query(
          sermonsRef.withConverter(sermonConverter),
          where('uploaderId', '==', user.uid),
          orderBy('dateMillis', 'desc'),
          orderBy('createdAtMillis', 'desc'),
          limit(queryLimit)
        )
      : query(sermonsRef.withConverter(sermonConverter), orderBy('createdAtMillis', 'desc'), limit(queryLimit));
  const [sermons, loading, error] = useCollection(q, {
    snapshotListenOptions: { includeMetadataChanges: true },
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error(error);
  }
  // const [searchQuery, setSearchQuery] = useState('');
  // const [currentPage, setCurrentPage] = useState(0);
  // const [searchResults, setSearchResults] = useState<Sermon[]>();
  // const [noMoreResults, setNoMoreResults] = useState(false);
  // const [filters, setFilters] = useState<string[]>([]);

  // IN ORDER TO DO SEARCH WE FIRST NEED TO FIGURE OUT HOW TO ONLY SEARCH ITEMS FROM THIS LIST AND NOT ALL ITEMS
  // const searchLists = useCallback(
  //   async (query?: string) => {
  //     setAlgoliaLoading(true);
  //     const res = await sermonsIndex?.search<Sermon>(query || searchQuery, {
  //       hitsPerPage: HITSPERPAGE,
  //       page: currentPage,
  //       ...(user.role !== UserRole.ADMIN && { filters: `uploaderId:${user.uid}` }),
  //       ...(filters.length !== 0 && { facetFilters: [filters.map((filter) => `${filter}`)] }),
  //     });
  //     if (res && res.hits.length > 0) {
  //       setNoMoreResults(false);
  //       setSearchResults(res.hits);
  //     } else {
  //       setNoMoreResults(true);
  //       setSearchResults([]);
  //     }
  //     setAlgoliaLoading(false);
  //   },
  //   [currentPage, filters, searchQuery, user?.role, user?.uid]
  // );

  // useEffect(() => {
  //   const fetchData = async () => {
  //     if (!(filters.length === 0 && searchQuery === '')) {
  //       await searchLists();
  //     }
  //   };
  //   fetchData();
  // }, [currentPage, filters, searchLists, searchQuery]);

  // const filterOptions = [
  //   { value: 'status.soundCloud:NOT_UPLOADED', label: 'Not Uploaded on SoundCloud' },
  //   { value: 'status.soundCloud:UPLOADED', label: 'Uploaded on SoundCloud' },
  //   { value: 'status.subsplash:NOT_UPLOADED', label: 'Not Uploaded on Subsplash' },
  //   { value: 'status.subsplash:UPLOADED', label: 'Uploaded on Subsplash' },
  // ];

  return (
    <Box width="100%" display="flex" flexDirection="column" alignItems="center" gap="10px" padding={3}>
      <Box display="flex" width={1}>
        <Box display="flex" sx={{ flex: 1, alignItems: 'center', justifyContent: 'left' }}>
          <Link href="/admin/lists">
            <Button variant="contained" disableRipple>
              Back
            </Button>
          </Link>
        </Box>
        <Typography variant="h3">Manage Sermons</Typography>
        <Box sx={{ flex: 1 }} />
      </Box>
      {/* <Box display="flex" width="100%" justifyContent="space-between">
        <TextField
          placeholder="Search a for a sermon by name, subtitle, speaker, or description"
          onChange={async (e) => {
            setSearchQuery(e.target.value);
            setCurrentPage(0);
            if (e.target.value === '') {
              setSearchResults(undefined);
            } else {
              await searchLists(e.target.value);
            }
          }}
          sx={{ width: '65%' }}
        />
        <Box sx={{ width: '34%' }}>
          <FormControl fullWidth>
            <InputLabel id="filter-select-label">Filter</InputLabel>
            <Select
              multiple
              value={filters}
              label="Filter"
              labelId="filter-select-label"
              id="filter-select"
              onChange={(e) => {
                setCurrentPage(0);
                const {
                  target: { value },
                } = e;
                if (typeof value === 'object' && value.find((v: string) => v === '') !== undefined) {
                  setFilters([]);
                  setSearchResults(undefined);
                } else {
                  setFilters(typeof value === 'string' ? value.split(',') : value);
                }
              }}
              renderValue={(selected) =>
                filters.length === 0
                  ? 'None'
                  : selected.map((option) => filterOptions.find((filter) => filter.value === option)?.label).join(', ')
              }
            >
              <MenuItem value={''}>
                <Checkbox checked={filters.length === 0} />
                <ListItemText primary={'None'} />
              </MenuItem>
              {filterOptions.map((option) => (
                <MenuItem key={option.value} value={option.value}>
                  <Checkbox checked={filters.find((filter) => filter === option.value) !== undefined} />
                  <ListItemText primary={option.label} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
      </Box> */}
      {error && (
        <Typography component="div">
          <Box fontWeight="bold" display="inline">
            Error: {JSON.stringify(error)}
          </Box>
        </Typography>
      )}
      {loading && (
        <>
          <SermonsList sermons={previousSermons} />
          <SermonListSkeloten count={count} />
        </>
      )}
      {/* //   searchResults ? (
      //   <SermonsList sermons={searchResults} />
      // ) : ( */}
      {sermons && (
        <>
          <SermonsList sermons={sermons.docs.map((doc) => doc.data())} />
          {(sermons.size ?? 0) - previousSermonsCount === HITSPERPAGE && (
            <Button
              onClick={() => {
                setQueryLimit((previousLimit) => previousLimit + HITSPERPAGE);
                setPreviousSermons(sermons.docs.map((doc) => doc.data()));
                setPreviousSermonsCount(sermons.size);
              }}
            >
              Load More
            </Button>
          )}
        </>
      )}
      {/* {noMoreResults && <Typography alignSelf="center">No results found</Typography>} */}
    </Box>
  );
};

const AdminSermonsList: FunctionComponent<AdminSermonsListProps> = (props) => {
  return (
    <UserRoleGuard
      allowedUserRoles={['admin', 'uploader', 'publisher']}
      renderItems={(user) => <AdminSermonsListWithUser {...props} user={user} />}
    />
  );
};

export default AdminSermonsList;
