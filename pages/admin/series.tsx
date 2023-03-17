import Box from '@mui/material/Box';
import AdminLayout from '../../layout/adminLayout';
import Button from '@mui/material/Button';
import firestore, { collection, deleteDoc, doc } from '../../firebase/firestore';
// import { useCollection } from 'react-firebase-hooks/firestore';
// import { sermonConverter } from '../../types/Sermon';
import DeleteEntityPopup from '../../components/DeleteEntityPopup';
import { useEffect, useState } from 'react';
import { Series, seriesConverter } from '../../types/Series';
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
import List from '@mui/material/List';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ListItemButton from '@mui/material/ListItemButton';

const AdminSeries = () => {
  const [firebaseSeries, loading, error] = useCollectionData(
    collection(firestore, 'series').withConverter(seriesConverter)
  );
  const [series, setSeries] = useState<Series[]>([]);
  const [editSeriesPopup, setEditSeriesPopup] = useState<boolean>(false);
  const [deleteSeriesPopup, setDeleteSeriesPopup] = useState<boolean>(false);
  const [newSeriesPopup, setNewSeriesPopup] = useState<boolean>(false);
  const [selectedSeries, setSelectedSeries] = useState<Series>();
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const disableButtons = isDeleting;
  const handleSeriesDelete = async () => {
    if (!selectedSeries) {
      return;
    }
    try {
      setIsDeleting(true);
      const deleteSubsplashList = createFunctionV2<DeleteSubsplashListInputType, DeleteSubsplashListOutputType>(
        'deletesubsplashlist'
      );
      if (selectedSeries.subsplashId) {
        await deleteSubsplashList({ listId: selectedSeries.subsplashId });
      }
      await deleteDoc(doc(firestore, 'series', selectedSeries.id));
      setSeries((oldSeries) => oldSeries.filter((series) => series.id !== selectedSeries.id));
    } catch (e) {
      alert('Error deleting series');
    } finally {
      setIsDeleting(false);
    }
  };

  useEffect(() => {
    if (firebaseSeries) {
      setSeries(firebaseSeries);
    }
  }, [firebaseSeries]);

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
              <Typography variant="h4">Manage Series</Typography>
              <Button
                color="info"
                variant="contained"
                size="small"
                onClick={() => {
                  setNewSeriesPopup(true);
                }}
              >
                Add Series
              </Button>
            </Box>
            <List>
              {series.map((s) => {
                return (
                  <Link href={`/admin/series/${s.id}?count=${s.count}`} key={s.id}>
                    <ListItemButton sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Box display="flex" alignItems="center" gap={1}>
                        <AvatarWithDefaultImage
                          image={s.images.find((image) => image.type === 'square')}
                          altName={`Image of Series: ${s.name}`}
                          width={50}
                          height={50}
                          borderRadius={5}
                        />
                        <Typography>{s.name}</Typography>
                        <Typography>{`Count: ${s.count}`}</Typography>
                      </Box>
                      <Box>
                        <Tooltip title="Edit Series">
                          <span>
                            <IconButton
                              disabled={disableButtons}
                              aria-label="edit series"
                              style={{ color: 'lightblue' }}
                              onClick={(e) => {
                                e.preventDefault();
                                setSelectedSeries(s);
                                setEditSeriesPopup(true);
                              }}
                            >
                              <EditIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Delete Series From All Systems">
                          <span>
                            <IconButton
                              disabled={disableButtons}
                              aria-label="delete series"
                              style={{ color: 'red' }}
                              onClick={(e) => {
                                e.preventDefault();
                                setSelectedSeries(s);
                                setDeleteSeriesPopup(true);
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
            </List>
          </Box>
        )}
      </Box>
      <DeleteEntityPopup
        entityBeingDeleten="series"
        handleDelete={handleSeriesDelete}
        deleteConfirmationPopup={deleteSeriesPopup}
        setDeleteConfirmationPopup={setDeleteSeriesPopup}
        isDeleting={isDeleting}
      />
      <NewSeriesPopup
        newSeriesPopup={newSeriesPopup}
        setNewSeriesPopup={setNewSeriesPopup}
        seriesArray={series}
        // setSeriesArray={setSeries}
      />
      <NewSeriesPopup
        newSeriesPopup={editSeriesPopup}
        setNewSeriesPopup={setEditSeriesPopup}
        seriesArray={series}
        // setSeriesArray={setSeries}
        existingSeries={selectedSeries}
      />
    </>
  );
};

AdminSeries.PageLayout = AdminLayout;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  return adminProtected(ctx);
};

export default AdminSeries;
