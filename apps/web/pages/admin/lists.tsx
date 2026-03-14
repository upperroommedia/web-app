import { ChangeEvent, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import AppLayout from '../../layout/AppLayout';
import DeleteEntityPopup from '../../components/DeleteEntityPopup';
import ListTable from '../../components/ListTable';
import NewListPopup, { listTypeOptions } from '../../components/NewListPopup';
import useAuth from '../../context/user/UserContext';
import { useAlgoliaSearch } from '../../context/search/AlgoliaSearchContext';
import { Order } from '../../context/types';
import { createFunctionV2 } from '../../utils/createFunction';
import { normalizeAlgoliaListHit, searchListsIndex } from '../../utils/algolia/searchRecords';
import { getDefaultListSortOrder } from '../../utils/algolia/listSorting';
import { DeleteSubsplashListInputType, DeleteSubsplashListOutputType } from '@upperroom/contracts/deleteSubsplashList';
import firestore, { deleteDoc, doc } from '../../firebase/firestore';
import { List, ListType } from '../../types/List';

const createDeleteSubsplashList = createFunctionV2<DeleteSubsplashListInputType, DeleteSubsplashListOutputType>(
  'deletesubsplashlist'
);

const AdminList = () => {
  const { searchClient, loading: searchClientLoading, error: searchClientError, clearCache } = useAlgoliaSearch();
  const [searchValue, setSearchValue] = useState<string>('');
  const [debouncedSearchValue, setDebouncedSearchValue] = useState<string>('');
  const [listTypeFilter, setListTypeFilter] = useState<ListType | ''>('');
  const [page, setPage] = useState<number>(0);
  const [rowsPerPage, setRowsPerPage] = useState<number>(25);
  const [lists, setLists] = useState<List[]>([]);
  const [listsLoading, setListsLoading] = useState<boolean>(false);
  const [totalLists, setTotalLists] = useState<number>(0);
  const [sortProperty, setSortProperty] = useState<keyof List>('name');
  const [sortOrder, setSortOrder] = useState<Order>(getDefaultListSortOrder('name'));
  const [newListPopup, setNewListPopup] = useState<boolean>(false);
  const [editListPopup, setEditListPopup] = useState<boolean>(false);
  const [deleteListPopup, setDeleteListPopup] = useState<boolean>(false);
  const [selectedList, setSelectedList] = useState<List>();
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchValue(searchValue);
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [searchValue]);

  useEffect(() => {
    if (!searchClient) {
      return;
    }

    let cancelled = false;

    const loadLists = async () => {
      setListsLoading(true);

      try {
        const response = await searchListsIndex(searchClient, {
          query: debouncedSearchValue,
          hitsPerPage: rowsPerPage,
          page,
          sortProperty,
          sortOrder,
          listType: listTypeFilter,
        });

        if (cancelled) {
          return;
        }

        setTotalLists(response.nbHits ?? 0);
        setLists(response.hits.map(normalizeAlgoliaListHit));
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load lists from Algolia', error);
          setLists([]);
          setTotalLists(0);
        }
      } finally {
        if (!cancelled) {
          setListsLoading(false);
        }
      }
    };

    void loadLists();

    return () => {
      cancelled = true;
    };
  }, [debouncedSearchValue, listTypeFilter, page, refreshNonce, rowsPerPage, searchClient, sortOrder, sortProperty]);

  const handleDeleteList = async () => {
    if (!selectedList) {
      return;
    }

    try {
      setIsDeleting(true);
      if (selectedList.subsplashId) {
        await createDeleteSubsplashList({ listId: selectedList.subsplashId });
      }
      await deleteDoc(doc(firestore, 'lists', selectedList.id));
      await clearCache();
      setLists((previousLists) => previousLists.filter((list) => list.id !== selectedList.id));
      setTotalLists((previousTotal) => Math.max(0, previousTotal - 1));
      setRefreshNonce((currentValue) => currentValue + 1);
    } catch (error) {
      console.error(error);
      alert('Error deleting list');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSort = async (property: keyof List, order: Order) => {
    setSortProperty(property);
    setSortOrder(order);
    setPage(0);
  };

  const handlePageChange = async (newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = async (event: ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const isLoading = listsLoading || searchClientLoading;

  return (
    <>
      <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
        {searchClientError ? (
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <Typography color="error">{searchClientError}</Typography>
          </Box>
        ) : (
          <ListTable
            lists={lists}
            page={page}
            rowsPerPage={rowsPerPage}
            totalLists={totalLists}
            sortOrder={sortOrder}
            sortProperty={sortProperty}
            searchValue={searchValue}
            listTypeFilter={listTypeFilter}
            loading={isLoading}
            handlePageChange={handlePageChange}
            handleChangeRowsPerPage={handleChangeRowsPerPage}
            handleSort={handleSort}
            onSearchChange={(value) => {
              setSearchValue(value);
              setPage(0);
            }}
            onFilterChange={(value) => {
              setListTypeFilter(value);
              setPage(0);
            }}
            onAddList={() => setNewListPopup(true)}
            onEditList={(list) => {
              setSelectedList(list);
              setEditListPopup(true);
            }}
            onDeleteList={(list) => {
              setSelectedList(list);
              setDeleteListPopup(true);
            }}
            disableButtons={isDeleting}
            listTypeOptions={listTypeOptions}
          />
        )}
      </Box>
      <DeleteEntityPopup
        entityBeingDeleted="list"
        deleteConfirmationPopup={deleteListPopup}
        setDeleteConfirmationPopup={setDeleteListPopup}
        handleDelete={handleDeleteList}
        isDeleting={isDeleting}
      />
      {newListPopup ? (
        <NewListPopup
          newListPopup={newListPopup}
          setNewListPopup={setNewListPopup}
          listArray={lists}
          setListArray={setLists}
        />
      ) : null}
      {editListPopup ? (
        <NewListPopup
          newListPopup={editListPopup}
          setNewListPopup={setEditListPopup}
          listArray={lists}
          setListArray={setLists}
          existingList={selectedList}
        />
      ) : null}
    </>
  );
};

const ProtectedAdminList = () => {
  const { user } = useAuth();

  if (!user?.isAdmin()) {
    return null;
  }

  return <AdminList />;
};

ProtectedAdminList.PageLayout = AppLayout;

export default ProtectedAdminList;
