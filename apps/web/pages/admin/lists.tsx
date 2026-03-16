import { ChangeEvent, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import MuiList from '@mui/material/List';
import MuiListItem from '@mui/material/ListItem';
import MuiListItemText from '@mui/material/ListItemText';
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
  DeleteSubsplashListBlockedDetails,
  DeleteSubsplashListInputType,
  DeleteSubsplashListOutputType,
} from '@upperroom/contracts/deleteSubsplashList';
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
  const [sortProperty, setSortProperty] = useState<ListSortableProperty>('name');
  const [sortOrder, setSortOrder] = useState<Order>(getDefaultListSortOrder('name'));
  const [newListPopup, setNewListPopup] = useState<boolean>(false);
  const [editListPopup, setEditListPopup] = useState<boolean>(false);
  const [deleteListPopup, setDeleteListPopup] = useState<boolean>(false);
  const [selectedList, setSelectedList] = useState<List>();
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState<boolean>(false);
  const [deleteErrorMessage, setDeleteErrorMessage] = useState<string>('');
  const [blockedDeleteDetails, setBlockedDeleteDetails] = useState<DeleteSubsplashListBlockedDetails | null>(null);
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
    setBlockedDeleteDetails(null);
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
      if (selectedList.subsplashId) {
        const deleteResult = await createDeleteSubsplashList({ listId: selectedList.id });
        if (deleteResult.status === 'blocked') {
          setBlockedDeleteDetails(deleteResult.blocked);
          setDeleteErrorMessage('');
          return;
        }
      }
      await deleteDoc(doc(firestore, 'lists', selectedList.id));
      await clearCache();
      setLists((previousLists) => previousLists.filter((list) => list.id !== selectedList.id));
      setTotalLists((previousTotal) => Math.max(0, previousTotal - 1));
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

  const activeBlockedDeleteDetails =
    blockedDeleteDetails ??
    (selectedList && getListOverflowIndicator(selectedList)
      ? {
          reason: 'ROOT_HAS_OVERFLOW_PAGES' as const,
          requestedListId: selectedList.id,
          rootListId: selectedList.rootListId ?? selectedList.id,
          rootName: selectedList.name,
          logicalCount: getListDiscoveryCount(selectedList),
          totalPages: 0,
          overflowPageCount: 0,
          overflowPages: [],
        }
      : null);

  const deleteImpactSummary =
    activeBlockedDeleteDetails && activeBlockedDeleteDetails.totalPages > 0
      ? `${activeBlockedDeleteDetails.totalPages} linked pages`
      : 'linked overflow continuation pages';

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
          activeBlockedDeleteDetails
            ? 'Delete blocked for overflow chain'
            : 'Are you sure you want to permanently delete this list?'
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
            color={activeBlockedDeleteDetails ? 'warning' : 'error'}
            disabled={!deleteConfirmed || isDeleting || Boolean(blockedDeleteDetails)}
          >
            {isDeleting ? <CircularProgress size={20} color="inherit" /> : blockedDeleteDetails ? 'Delete Blocked' : 'Delete Forever'}
          </Button>
        }
      >
        <Box display="flex" flexDirection="column" gap={2} sx={{ minWidth: { xs: 0, sm: 440 } }}>
          {deleteErrorMessage ? <Alert severity="error">{deleteErrorMessage}</Alert> : null}
          {activeBlockedDeleteDetails ? (
            <Alert severity="warning">
              {`This root list is part of an overflow chain. Deleting it would affect ${deleteImpactSummary}, so the delete path stops instead of cascading.`}
            </Alert>
          ) : null}
          {selectedList ? (
            <Box>
              <Typography variant="body2" color="text.secondary">
                {activeBlockedDeleteDetails
                  ? `Logical list: ${activeBlockedDeleteDetails.rootName}`
                  : `List: ${selectedList.name}`}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {`Logical items: ${activeBlockedDeleteDetails ? activeBlockedDeleteDetails.logicalCount : getListDiscoveryCount(selectedList)}`}
              </Typography>
              {activeBlockedDeleteDetails ? (
                <Typography variant="body2" color="text.secondary">
                  {activeBlockedDeleteDetails.totalPages > 0
                    ? `Overflow pages: ${activeBlockedDeleteDetails.overflowPageCount} of ${activeBlockedDeleteDetails.totalPages} physical pages`
                    : 'Overflow pages exist on this root list and must be removed before deletion.'}
                </Typography>
              ) : null}
            </Box>
          ) : null}
          {blockedDeleteDetails?.overflowPages.length ? (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Blocked continuation pages
              </Typography>
              <MuiList dense disablePadding>
                {blockedDeleteDetails.overflowPages.map((page) => (
                  <MuiListItem key={page.firestoreListId} disableGutters>
                    <MuiListItemText
                      primary={page.name}
                      secondary={`Depth ${page.depth} • ${page.count} items${page.subsplashId ? ` • ${page.subsplashId}` : ''}`}
                    />
                  </MuiListItem>
                ))}
              </MuiList>
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
