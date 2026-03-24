import { ChangeEvent, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';
import AppLayout from '../../layout/AppLayout';
import ListTable from '../../components/ListTable';
import NewListPopup, { listTypeOptions } from '../../components/NewListPopup';
import PopUp from '../../components/PopUp';
import useAuth from '../../context/user/UserContext';
import { useAlgoliaSearch } from '../../context/search/AlgoliaSearchContext';
import { Order } from '../../context/types';
import { createFunctionV2 } from '../../utils/createFunction';
import {
  getListDiscoveryCount,
  getListOverflowIndicator,
  normalizeAlgoliaListHit,
  searchListsIndex,
} from '../../utils/algolia/searchRecords';
import { getDefaultListSortOrder } from '../../utils/algolia/listSorting';
import type { ListSortableProperty } from '../../utils/algolia/listSorting';
import {
  DeleteSubsplashListInputType,
  DeleteSubsplashListOutputType,
} from '@upperroom/contracts/deleteSubsplashList';
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
  const [sortProperty, setSortProperty] = useState<ListSortableProperty>('name');
  const [sortOrder, setSortOrder] = useState<Order>(getDefaultListSortOrder('name'));
  const [newListPopup, setNewListPopup] = useState<boolean>(false);
  const [editListPopup, setEditListPopup] = useState<boolean>(false);
  const [deleteListPopup, setDeleteListPopup] = useState<boolean>(false);
  const [selectedList, setSelectedList] = useState<List>();
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState<boolean>(false);
  const [deleteErrorMessage, setDeleteErrorMessage] = useState<string>('');
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

  const resetDeleteDialogState = () => {
    setDeleteConfirmed(false);
    setDeleteErrorMessage('');
  };

  const closeDeleteListPopup = () => {
    setDeleteListPopup(false);
    resetDeleteDialogState();
  };

  const handleDeleteList = async () => {
    if (!selectedList) {
      return;
    }

    try {
      setIsDeleting(true);
      const deleteResult = await createDeleteSubsplashList({ listId: selectedList.id });
      await clearCache();
      const deletedIdSet = new Set(deleteResult.deletedFirestoreListIds);
      setLists((previousLists) => previousLists.filter((list) => !deletedIdSet.has(list.id)));
      setTotalLists((previousTotal) => Math.max(0, previousTotal - deleteResult.deletedFirestoreListIds.length));
      setRefreshNonce((currentValue) => currentValue + 1);
      closeDeleteListPopup();
      setSelectedList(undefined);
    } catch (error) {
      console.error(error);
      setDeleteErrorMessage(error instanceof Error ? error.message : 'Error deleting list');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSort = async (property: ListSortableProperty, order: Order) => {
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
              resetDeleteDialogState();
              setDeleteListPopup(true);
            }}
            disableButtons={isDeleting}
            listTypeOptions={listTypeOptions}
          />
        )}
      </Box>
      <PopUp
        title={
          'Are you sure you want to permanently delete this list?'
        }
        open={deleteListPopup}
        setOpen={(open) => {
          if (!open) {
            closeDeleteListPopup();
          } else {
            setDeleteListPopup(open);
          }
        }}
        onClose={resetDeleteDialogState}
        button={
          <Button
            aria-label="confirm delete list"
            onClick={handleDeleteList}
            color="error"
            disabled={!deleteConfirmed || isDeleting}
          >
            {isDeleting ? <CircularProgress size={20} color="inherit" /> : 'Delete Forever'}
          </Button>
        }
      >
        <Box display="flex" flexDirection="column" gap={2} sx={{ minWidth: { xs: 0, sm: 440 } }}>
          {deleteErrorMessage ? <Alert severity="error">{deleteErrorMessage}</Alert> : null}
          {selectedList ? (
            <Box>
              <Typography variant="body2" color="text.secondary">
                {`List: ${selectedList.name}`}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {`Logical items: ${getListDiscoveryCount(selectedList)}`}
              </Typography>
              {getListOverflowIndicator(selectedList) ? (
                <Typography variant="body2" color="text.secondary">
                  Deleting this logical list will also delete all linked overflow pages.
                </Typography>
              ) : null}
            </Box>
          ) : null}
          <FormControlLabel
            control={
              <Checkbox
                checked={deleteConfirmed}
                onChange={(event) => setDeleteConfirmed(event.target.checked)}
              />
            }
            label="I understand that deleting is permanent and cannot be undone"
          />
        </Box>
      </PopUp>
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
