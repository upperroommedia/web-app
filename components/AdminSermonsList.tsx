import Typography from '@mui/material/Typography';
import { Box } from '@mui/system';
import firestore, { collection, orderBy, query } from '../firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import BottomAudioBar from './BottomAudioBar';
import SermonsList from './SermonsList';
import { sermonConverter } from '../types/Sermon';
import SermonListSkeloten from './skeletons/SermonListSkeloten';
import { FunctionComponent, useEffect, useState } from 'react';
import TextField from '@mui/material/TextField';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import { Sermon } from '../types/SermonTypes';
import algoliasearch from 'algoliasearch';
import { createInMemoryCache } from '@algolia/cache-in-memory';
import Checkbox from '@mui/material/Checkbox';
import ListItemText from '@mui/material/ListItemText';

interface AdminSermonsListProps {
  collectionPath: string;
  count?: number;
}

const HITSPERPAGE = 20;

const client =
  process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
    ? algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY, {
        responsesCache: createInMemoryCache(),
        requestsCache: createInMemoryCache({ serializable: false }),
      })
    : undefined;
const sermonsIndex = client?.initIndex('sermons');

const AdminSermonsList: FunctionComponent<AdminSermonsListProps> = ({
  collectionPath,
  count,
}: AdminSermonsListProps) => {
  const sermonsRef = collection(firestore, collectionPath);
  const q = query(sermonsRef.withConverter(sermonConverter), orderBy('date', 'desc'));
  const [sermons, loading, error] = useCollection(q, {
    snapshotListenOptions: { includeMetadataChanges: true },
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(0);
  const [searchResults, setSearchResults] = useState<Sermon[]>();
  const [noMoreResults, setNoMoreResults] = useState(false);
  const [filters, setFilters] = useState<string[]>([]);

  const searchLists = async (query?: string) => {
    const res = await sermonsIndex?.search<Sermon>(query || searchQuery, {
      hitsPerPage: HITSPERPAGE,
      page: currentPage,
      ...(filters.length !== 0 && { facetFilters: [filters.map((filter) => `${filter}`)] }),
    });
    if (res && res.hits.length > 0) {
      setNoMoreResults(false);
      setSearchResults(res.hits);
    } else {
      setNoMoreResults(true);
      setSearchResults([]);
    }
  };

  useEffect(() => {
    const fetchData = async () => {
      if (!(filters.length === 0 && searchQuery === '')) {
        await searchLists();
      }
    };
    fetchData();
  }, [currentPage, filters]);

  const filterOptions = [
    { value: 'status.soundCloud:NOT_UPLOADED', label: 'Not Uploaded on SoundCloud' },
    { value: 'status.soundCloud:UPLOADED', label: 'Uploaded on SoundCloud' },
    { value: 'status.subsplash:NOT_UPLOADED', label: 'Not Uploaded on Subsplash' },
    { value: 'status.subsplash:UPLOADED', label: 'Uploaded on Subsplash' },
  ];

  return (
    <Box width="100%" display="flex" flexDirection="column" alignItems="center" gap="10px" padding={3}>
      <Typography variant="h3">Manage Sermons</Typography>
      <Box display="flex" width="100%" justifyContent="space-between">
        <TextField
          placeholder="Search a for a sermon by name, subtitle, or description"
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
      </Box>
      {error && (
        <Typography component="div">
          <Box fontWeight="bold" display="inline">
            Error: {JSON.stringify(error)}
          </Box>
        </Typography>
      )}
      {loading && <SermonListSkeloten count={count} />}
      {searchResults ? (
        <SermonsList sermons={searchResults} />
      ) : (
        sermons && <SermonsList sermons={sermons.docs.map((doc) => doc.data())} />
      )}
      {noMoreResults && <Typography alignSelf="center">No results found</Typography>}
      <BottomAudioBar />
    </Box>
  );
};

export default AdminSermonsList;
