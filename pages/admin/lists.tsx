import Box from '@mui/material/Box';
import AdminLayout from '../../layout/adminLayout';
import Button from '@mui/material/Button';
import firestore, { collection, deleteDoc, doc, limit, orderBy, query } from '../../firebase/firestore';
// import { useCollection } from 'react-firebase-hooks/firestore';
// import { sermonConverter } from '../../types/Sermon';
import DeleteEntityPopup from '../../components/DeleteEntityPopup';
import { useEffect, useState } from 'react';
// import { GetServerSideProps, GetServerSidePropsContext } from 'next';
// import { adminProtected } from '../../utils/protectedRoutes';
import NewListPopup, { listTypeOptions } from '../../components/NewListPopup';
import AvatarWithDefaultImage from '../../components/AvatarWithDefaultImage';
import Typography from '@mui/material/Typography';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import CircularProgress from '@mui/material/CircularProgress';
import { createFunctionV2 } from '../../utils/createFunction';
import { DeleteSubsplashListInputType, DeleteSubsplashListOutputType } from '../../functions/src/deleteSubsplashList';
import Link from 'next/link';
import MaterialList from '@mui/material/List';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ListItemButton from '@mui/material/ListItemButton';
import { listConverter, List, ListType } from '../../types/List';
import { createInMemoryCache } from '@algolia/cache-in-memory';
import algoliasearch from 'algoliasearch';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import InputLabel from '@mui/material/InputLabel';
import FormControl from '@mui/material/FormControl';
import useAuth from '../../context/user/UserContext';

const HITSPERPAGE = 20;

const client =
  process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
    ? algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY, {
        responsesCache: createInMemoryCache(),
        requestsCache: createInMemoryCache({ serializable: false }),
      })
    : undefined;
const listsIndex = client?.initIndex('lists');

const AdminList = () => {
  const { user } = useAuth();
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

  if (!user?.isAdmin()) {
    return null;
  }

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
    } catch (e) {
      alert('Error deleting list');
    } finally {
      setIsDeleting(false);
    }
  };

  const searchLists = async (query?: string) => {
    const res = await listsIndex?.search<List>(query || searchQuery, {
      hitsPerPage: HITSPERPAGE,
      page: currentPage,
      ...(filter !== '' && { facetFilters: [`type:${filter}`] }),
    });
    if (res && res.hits.length > 0) {
      setNoMoreResults(false);
      setSearchResults(res.hits);
    } else {
      setSearchResults([]);
      setNoMoreResults(true);
    }
  };

  useEffect(() => {
    if (firebaseList) {
      setList(firebaseList);
    }
  }, [firebaseList]);

  useEffect(() => {
    const fetchData = async () => {
      await searchLists();
    };
    fetchData();
  }, [currentPage, filter]);

  return (
    <>
      <Box display="flex" justifyContent="center" padding={3} width={1}>
        {error ? (
          <Typography color="red">{`Error: ${error.message}`}</Typography>
        ) : loading ? (
          <CircularProgress />
        ) : (
          <Box display="flex" flexDirection="column" gap={1} width={1}>
            <Box display="flex" justifyContent="center" gap={1}>
              <Typography variant="h4">Manage List</Typography>
              <Button
                color="info"
                variant="contained"
                size="small"
                onClick={() => {
                  setNewListPopup(true);
                }}
              >
                Add List
              </Button>
            </Box>
            <Box display="flex" width="100%" justifyContent="space-between">
              <TextField
                placeholder="Search a for a list"
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
                  <InputLabel id="list-type-select-label">Filter by list type</InputLabel>
                  <Select
                    value={filter}
                    label="Filter by list type"
                    labelId="list-type-select-label"
                    id="list-type-select"
                    onChange={(e) => {
                      setCurrentPage(0);
                      setFilter(e.target.value as ListType);
                    }}
                  >
                    <MenuItem value={''}>None</MenuItem>
                    {/* eslint-disable-next-line array-callback-return */}
                    {(Object.values(ListType) as Array<ListType>).map((listType) => {
                      if (listType !== ListType.LATEST) {
                        return (
                          <MenuItem key={listType} value={listType}>
                            {listTypeOptions[listType]}
                          </MenuItem>
                        );
                      }
                    })}
                  </Select>
                </FormControl>
              </Box>
            </Box>
            <MaterialList>
              {(searchResults || list).map((l) => {
                return (
                  <Link href={`/admin/lists/${l.id}?count=${l.count}`} key={l.id}>
                    <ListItemButton sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Box display="flex" alignItems="center" gap={1}>
                        <AvatarWithDefaultImage
                          image={l.images?.find((image) => image.type === 'square')}
                          altName={`Image of List: ${l.name}`}
                          width={50}
                          height={50}
                          borderRadius={5}
                        />
                        <Typography>{l.name}</Typography>
                        <Typography>{`Count: ${l.count}`}</Typography>
                        <Typography>{`Type: ${l.type}`}</Typography>
                      </Box>
                      <Box>
                        <Tooltip title="Edit List">
                          <span>
                            <IconButton
                              disabled={disableButtons}
                              aria-label="edit list"
                              style={{ color: 'lightblue' }}
                              onClick={(e) => {
                                e.preventDefault();
                                setSelectedList(l);
                                setEditListPopup(true);
                              }}
                            >
                              <EditIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Delete List From All Systems">
                          <span>
                            <IconButton
                              disabled={disableButtons}
                              aria-label="delete list"
                              style={{ color: 'red' }}
                              onClick={(e) => {
                                e.preventDefault();
                                setSelectedList(l);
                                setDeleteListPopup(true);
                              }}
                            >
                              <DeleteIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Box>
                    </ListItemButton>
                    <Divider />
                  </Link>
                );
              })}
            </MaterialList>
            <Box display="flex" gap={2} justifyContent="center" width={'100%'}>
              {currentPage > 0 && (
                <Button onClick={() => setCurrentPage((oldPage) => oldPage - 1)}>Previous Page</Button>
              )}
              {!noMoreResults && !(searchResults && searchResults.length < HITSPERPAGE) && (
                <Button onClick={() => setCurrentPage((oldPage) => oldPage + 1)}>Next Page</Button>
              )}
              {!noMoreResults && searchResults && searchResults.length < HITSPERPAGE && (
                <Typography alignSelf="center">{'No more results'}</Typography>
              )}
              {noMoreResults && <Typography alignSelf="center">No results found</Typography>}
            </Box>
          </Box>
        )}
      </Box>
      <DeleteEntityPopup
        entityBeingDeleten="list"
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

AdminList.PageLayout = AdminLayout;

// export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
//   return adminProtected(ctx);
// };

export default AdminList;
