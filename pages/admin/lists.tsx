import Box from '@mui/material/Box';
import AppLayout from '../../layout/AppLayout';
import Button from '@mui/material/Button';
import firestore, { collection, deleteDoc, doc, limit, orderBy, query } from '../../firebase/firestore';
import DeleteEntityPopup from '../../components/DeleteEntityPopup';
import { useCallback, useEffect, useState } from 'react';
import NewListPopup, { listTypeOptions } from '../../components/NewListPopup';
import AvatarWithDefaultImage from '../../components/AvatarWithDefaultImage';
import Typography from '@mui/material/Typography';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import CircularProgress from '@mui/material/CircularProgress';
import { createFunctionV2 } from '../../utils/createFunction';
import { DeleteSubsplashListInputType, DeleteSubsplashListOutputType } from '../../functions/src/deleteSubsplashList';
import Link from 'next/link';
import Card from '@mui/material/Card';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay';
import SearchIcon from '@mui/icons-material/Search';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import InputAdornment from '@mui/material/InputAdornment';
import { listConverter, List, ListType } from '../../types/List';
import { algoliasearch, SearchResponse } from 'algoliasearch';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import InputLabel from '@mui/material/InputLabel';
import FormControl from '@mui/material/FormControl';
import useAuth from '../../context/user/UserContext';
import { alpha, useTheme } from '@mui/material/styles';

const HITSPERPAGE = 20;

const client =
  process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
    ? algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY)
    : undefined;

const AdminList = () => {
  // Exclude overflow lists (isMoreSermonsList: true) from admin list view
  // Note: Firestore doesn't support != with undefined, so we use a compound query
  // We'll filter client-side for isMoreSermonsList !== true
  const q = query(collection(firestore, 'lists').withConverter(listConverter), orderBy('name'), limit(HITSPERPAGE));
  const [firebaseList, loading, error] = useCollectionData(q);
  const [list, setList] = useState<List[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<List[]>();
  const [currentPage, setCurrentPage] = useState<number>(0);
  const [noMoreResults, setNoMoreResults] = useState<boolean>(false);
  const [filter, setFilter] = useState<ListType | ''>('');
  const [editListPopup, setEditListPopup] = useState<boolean>(false);
  const [deleteListPopup, setDeleteListPopup] = useState<boolean>(false);
  const [newListPopup, setNewListPopup] = useState<boolean>(false);
  const [selectedList, setSelectedList] = useState<List>();
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const disableButtons = isDeleting;

  const handleListDelete = async () => {
    if (!selectedList) {
      return;
    }
    try {
      setIsDeleting(true);
      const deleteSubsplashList = createFunctionV2<DeleteSubsplashListInputType, DeleteSubsplashListOutputType>(
        'deletesubsplashlist'
      );
      if (selectedList.subsplashId) {
        await deleteSubsplashList({ listId: selectedList.subsplashId });
      }
      await deleteDoc(doc(firestore, 'lists', selectedList.id));
      setList((oldList) => oldList.filter((list) => list.id !== selectedList.id));
    } catch (_e) {
      alert('Error deleting list');
    } finally {
      setIsDeleting(false);
    }
  };

  const searchLists = useCallback(
    async (query?: string) => {
      if (client) {
        try {
          const res: SearchResponse<List> = await client.searchSingleIndex({
            indexName: 'lists',
            searchParams: {
              query: query || searchQuery,
              hitsPerPage: HITSPERPAGE,
              page: currentPage,
              ...(filter !== '' && { facetFilters: [`type:${filter}`] }),
              // Exclude overflow lists from search results
              filters: 'NOT isMoreSermonsList:true',
            },
          });
          // Also filter client-side as a safety measure
          const filteredHits = res.hits.filter((list) => list.isMoreSermonsList !== true);
          if (filteredHits.length > 0) {
            setNoMoreResults(false);
            setSearchResults(filteredHits);
          } else {
            setSearchResults([]);
            setNoMoreResults(true);
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('Search error:', error);
          setSearchResults([]);
          setNoMoreResults(true);
        }
      }
    },
    [currentPage, filter, searchQuery]
  );

  useEffect(() => {
    if (firebaseList) {
      // Filter out overflow lists (isMoreSermonsList: true) from admin view
      setList(firebaseList.filter((list) => list.isMoreSermonsList !== true));
    }
  }, [firebaseList]);

  useEffect(() => {
    const fetchData = async () => {
      await searchLists();
    };
    fetchData();
  }, [currentPage, filter, searchLists]);

  const theme = useTheme();

  return (
    <>
      <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
        {error ? (
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <Typography color="error">{`Error: ${error.message}`}</Typography>
          </Box>
        ) : loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            {/* Header */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                justifyContent: 'space-between',
                alignItems: { xs: 'flex-start', sm: 'center' },
                gap: 2,
                mb: 4,
              }}
            >
              <Typography variant="h4" fontWeight={700}>
                Manage Lists
              </Typography>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => setNewListPopup(true)}
              >
                Add List
              </Button>
            </Box>

            {/* Filters */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                gap: 2,
                mb: 3,
              }}
            >
              <TextField
                placeholder="Search lists by name..."
                value={searchQuery}
                onChange={async (e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(0);
                  if (e.target.value === '') {
                    setSearchResults(undefined);
                  } else {
                    await searchLists(e.target.value);
                  }
                }}
                size="small"
                sx={{ flex: 2 }}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon color="action" />
                    </InputAdornment>
                  ),
                }}
              />
              <FormControl size="small" sx={{ flex: 1, minWidth: 160 }}>
                <InputLabel id="list-type-select-label">Type</InputLabel>
                <Select
                  value={filter}
                  label="Type"
                  labelId="list-type-select-label"
                  onChange={(e) => {
                    setCurrentPage(0);
                    setFilter(e.target.value as ListType);
                  }}
                >
                  <MenuItem value="">All Types</MenuItem>
                  {(Object.values(ListType) as Array<ListType>).map((listType) => {
                    if (listType !== ListType.LATEST) {
                      return (
                        <MenuItem key={listType} value={listType}>
                          {listTypeOptions[listType]}
                        </MenuItem>
                      );
                    }
                    return null;
                  })}
                </Select>
              </FormControl>
            </Box>

            {/* Lists */}
            {(searchResults || list).length === 0 ? (
              <Card
                sx={{
                  textAlign: 'center',
                  py: 6,
                  px: 3,
                  border: '2px dashed',
                  borderColor: 'divider',
                  bgcolor: 'transparent',
                }}
              >
                <PlaylistPlayIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
                <Typography variant="h6" color="text.secondary" gutterBottom>
                  {searchQuery || filter ? 'No lists found matching your filters' : 'No lists yet'}
                </Typography>
                <Typography variant="body2" color="text.disabled" sx={{ mb: 3 }}>
                  {searchQuery || filter
                    ? 'Try adjusting your search or filter'
                    : 'Create your first list to organize your content'}
                </Typography>
                {!searchQuery && !filter && (
                  <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={() => setNewListPopup(true)}
                  >
                    Create Your First List
                  </Button>
                )}
              </Card>
            ) : (
              <Card>
                {(searchResults || list).map((l, index) => (
                  <Box key={l.id}>
                    <Link href={`/admin/lists/${l.id}?count=${l.count || 20}`} style={{ textDecoration: 'none' }}>
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          p: { xs: 2, sm: 2.5 },
                          gap: 2,
                          cursor: 'pointer',
                          transition: 'background-color 0.15s ease',
                          '&:hover': { bgcolor: 'action.hover' },
                        }}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0 }}>
                          <AvatarWithDefaultImage
                            image={l.images?.find((image) => image.type === 'square')}
                            altName={`Image of List: ${l.name}`}
                            width={64}
                            height={64}
                            borderRadius={10}
                            sx={{ flexShrink: 0 }}
                          />
                          <Box sx={{ minWidth: 0 }}>
                            <Typography
                              variant="subtitle1"
                              fontWeight={600}
                              sx={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {l.name}
                            </Typography>
                            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 0.5 }}>
                              {l.count !== undefined && (
                                <Typography variant="body2" color="text.secondary">
                                  {l.count} items
                                </Typography>
                              )}
                              <Chip
                                label={listTypeOptions[l.type] || l.type}
                                size="small"
                                variant="outlined"
                                sx={{ height: 22 }}
                              />
                            </Box>
                          </Box>
                        </Box>

                        <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                          <Tooltip title="Edit List">
                            <span>
                              <IconButton
                                disabled={disableButtons}
                                aria-label="edit list"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSelectedList(l);
                                  setEditListPopup(true);
                                }}
                                sx={{
                                  '&:hover': {
                                    bgcolor: alpha(theme.palette.primary.main, 0.15),
                                    color: 'primary.main',
                                  },
                                }}
                              >
                                <EditIcon />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="Delete List">
                            <span>
                              <IconButton
                                disabled={disableButtons}
                                aria-label="delete list"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSelectedList(l);
                                  setDeleteListPopup(true);
                                }}
                                sx={{
                                  color: 'error.main',
                                  '&:hover': {
                                    bgcolor: alpha(theme.palette.error.main, 0.15),
                                  },
                                }}
                              >
                                <DeleteIcon />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      </Box>
                    </Link>
                    {index < (searchResults || list).length - 1 && <Divider />}
                  </Box>
                ))}
              </Card>
            )}

            {/* Pagination */}
            {((searchResults || list).length > 0 || currentPage > 0) && (
              <Box display="flex" gap={2} justifyContent="center" mt={3}>
                {currentPage > 0 && (
                  <Button variant="outlined" onClick={() => setCurrentPage((oldPage) => oldPage - 1)}>
                    Previous Page
                  </Button>
                )}
                {!noMoreResults && !(searchResults && searchResults.length < HITSPERPAGE) && (
                  <Button variant="outlined" onClick={() => setCurrentPage((oldPage) => oldPage + 1)}>
                    Next Page
                  </Button>
                )}
              </Box>
            )}
          </>
        )}
      </Box>
      <DeleteEntityPopup
        entityBeingDeleted="list"
        handleDelete={handleListDelete}
        deleteConfirmationPopup={deleteListPopup}
        setDeleteConfirmationPopup={setDeleteListPopup}
        isDeleting={isDeleting}
      />
      {newListPopup && (
        <NewListPopup
          newListPopup={newListPopup}
          setNewListPopup={setNewListPopup}
          listArray={list}
          // setListArray={setList}
        />
      )}
      {editListPopup && (
        <NewListPopup
          newListPopup={editListPopup}
          setNewListPopup={setEditListPopup}
          listArray={list}
          // setListArray={setList}
          existingList={selectedList}
        />
      )}
    </>
  );
};

const ProtectedAdminList = () => {
  const { user } = useAuth();
  if (!user?.isAdmin()) {
    return null;
  } else {
    return <AdminList />;
  }
};

ProtectedAdminList.PageLayout = AppLayout;

export default ProtectedAdminList;
