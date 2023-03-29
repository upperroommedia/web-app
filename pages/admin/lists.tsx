import Box from '@mui/material/Box';
import AdminLayout from '../../layout/adminLayout';
import Button from '@mui/material/Button';
import firestore, { collection, deleteDoc, doc } from '../../firebase/firestore';
// import { useCollection } from 'react-firebase-hooks/firestore';
// import { sermonConverter } from '../../types/Sermon';
import DeleteEntityPopup from '../../components/DeleteEntityPopup';
import { useEffect, useState } from 'react';
import { GetServerSideProps, GetServerSidePropsContext } from 'next';
import { adminProtected } from '../../utils/protectedRoutes';
import NewSeriesPopup from '../../components/NewSeriesPopup';
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
import { listConverter, List } from '../../types/List';

const AdminList = () => {
  const [firebaseList, loading, error] = useCollectionData(collection(firestore, 'lists').withConverter(listConverter));
  const [list, setList] = useState<List[]>([]);
  const [editListPopup, setEditListPopup] = useState<boolean>(false);
  const [deleteListPopup, setDeleteListPopup] = useState<boolean>(false);
  const [newSeriesPopup, setNewSeriesPopup] = useState<boolean>(false);
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
      await deleteDoc(doc(firestore, 'list', selectedList.id));
      setList((oldList) => oldList.filter((list) => list.id !== selectedList.id));
    } catch (e) {
      alert('Error deleting list');
    } finally {
      setIsDeleting(false);
    }
  };

  useEffect(() => {
    if (firebaseList) {
      setList(firebaseList);
    }
  }, [firebaseList]);

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
                  setNewSeriesPopup(true);
                }}
              >
                Add List
              </Button>
            </Box>
            <MaterialList>
              {list.map((s) => {
                return (
                  <Link href={`/admin/lists/${s.id}?count=${s.count}`} key={s.id}>
                    <ListItemButton sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Box display="flex" alignItems="center" gap={1}>
                        <AvatarWithDefaultImage
                          image={s.images.find((image) => image.type === 'square')}
                          altName={`Image of List: ${s.name}`}
                          width={50}
                          height={50}
                          borderRadius={5}
                        />
                        <Typography>{s.name}</Typography>
                        <Typography>{`Count: ${s.count}`}</Typography>
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
                                setSelectedList(s);
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
                                setSelectedList(s);
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
      <NewSeriesPopup
        newSeriesPopup={newSeriesPopup}
        setNewSeriesPopup={setNewSeriesPopup}
        listArray={list}
        // setListArray={setList}
      />
      <NewSeriesPopup
        newSeriesPopup={editListPopup}
        setNewSeriesPopup={setEditListPopup}
        listArray={list}
        // setListArray={setList}
        existingList={selectedList}
      />
    </>
  );
};

AdminList.PageLayout = AdminLayout;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  return adminProtected(ctx);
};

export default AdminList;
