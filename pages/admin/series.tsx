import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import AdminLayout from '../../layout/adminLayout';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
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
import SeriesSermonList from '../../components/SeriesSermonsList';
import AvatarWithDefaultImage from '../../components/AvatarWithDefaultImage';
import Typography from '@mui/material/Typography';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import { CircularProgress } from '@mui/material';
import { createFunctionV2 } from '../../utils/createFunction';
import { DeleteSubsplashListInputType, DeleteSubsplashListOutputType } from '../../functions/src/deleteSubsplashList';

const AdminSeries = () => {
  const [firebaseSeries, loading, error] = useCollectionData(
    collection(firestore, 'series').withConverter(seriesConverter)
  );
  const [series, setSeries] = useState<Series[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<Series>();
  const [editSeriesPopup, setEditSeriesPopup] = useState<boolean>(false);
  const [deleteSeriesPopup, setDeleteSeriesPopup] = useState<boolean>(false);
  const [newSeriesPopup, setNewSeriesPopup] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const handleSeriesDelete = async () => {
    if (!selectedSeries) return;
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
            <Box>
              {series.map((s) => {
                return (
                  <Accordion TransitionProps={{ unmountOnExit: true }} key={s.id} onClick={() => setSelectedSeries(s)}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <AvatarWithDefaultImage
                          image={s.images.find((image) => image.type === 'square')}
                          altName={`Image of Series: ${s.name}`}
                          width={50}
                          height={50}
                          borderRadius={5}
                        />
                        <Typography>{s.name}</Typography>
                      </Box>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Box>
                        <Box display="flex" justifyContent="center" gap={1}>
                          <Button
                            color="info"
                            variant="contained"
                            size="small"
                            onClick={() => {
                              setEditSeriesPopup(true);
                            }}
                          >
                            Edit Series
                          </Button>

                          <Button
                            color="error"
                            variant="contained"
                            size="small"
                            disabled={isDeleting}
                            onClick={() => setDeleteSeriesPopup(true)}
                          >
                            {isDeleting ? <CircularProgress /> : 'Delete Series'}
                          </Button>
                        </Box>
                        <SeriesSermonList seriesId={s.id} />
                      </Box>
                    </AccordionDetails>
                  </Accordion>
                );
              })}
            </Box>
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
        setSeriesArray={setSeries}
      />
      <NewSeriesPopup
        newSeriesPopup={editSeriesPopup}
        setNewSeriesPopup={setEditSeriesPopup}
        seriesArray={series}
        setSeriesArray={setSeries}
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
