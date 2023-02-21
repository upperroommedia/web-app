import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import SermonsList from '../../components/SermonsList';
import Typography from '@mui/material/Typography';
import AdminLayout from '../../layout/adminLayout';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Button from '@mui/material/Button';
import firestore, { collection, deleteDoc, doc, getDocs, query, updateDoc } from '../../firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { sermonConverter } from '../../types/Sermon';
import EditSeriesComponent from '../../components/EditSeriesPopupComponent';
import DeleteEntityPopup from '../../components/DeleteEntityPopup';
import { useEffect, useState } from 'react';
import { Series, seriesConverter } from '../../types/Series';
import { GetServerSideProps, GetServerSidePropsContext } from 'next';
import { adminProtected } from '../../utils/protectedRoutes';

const AdminSeries = () => {
  const [series, setSeries] = useState<Series[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<Series>();
  const [newSeriesName, setNewSeriesName] = useState<string>('');
  const [editSeriesPopup, setEditSeriesPopup] = useState<boolean>(false);
  const [deleteSeriesPopup, setDeleteSeriesPopup] = useState<boolean>(false);

  const sermonsRef = collection(firestore, 'sermons');
  const q = query(sermonsRef.withConverter(sermonConverter));
  const [sermons] = useCollection(q, {
    snapshotListenOptions: { includeMetadataChanges: true },
  });

  const handleSeriesDelete = async () => {
    if (selectedSeries) {
      await deleteDoc(doc(firestore, 'series', selectedSeries.id));
      selectedSeries.sermonIds.forEach(async (id) => {
        const sermonRef = doc(firestore, 'sermons', id).withConverter(sermonConverter);
        await updateDoc(sermonRef, {
          series: {},
        });
      });
      setSeries((oldSeries) => oldSeries.filter((series) => series.id !== selectedSeries.id));
    }
  };

  const fetchSeries = async () => {
    const seriesQuery = query(collection(firestore, 'series').withConverter(seriesConverter));
    const seriesQuerySnapshot = await getDocs(seriesQuery);
    seriesQuerySnapshot.docs.forEach((doc) => {
      setSeries((oldSeries) => [...oldSeries, doc.data()]);
    });
  };
  useEffect(() => {
    const g = async () => {
      await fetchSeries();
    };
    g();
  }, []);

  return (
    <>
      <Box>
        <Typography variant="h2">Manage Series</Typography>
        {series.map((s) => {
          return (
            <Accordion key={s.id} onClick={() => setSelectedSeries(s)}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <p>{s.name}</p>
              </AccordionSummary>
              <AccordionDetails>
                <Box>
                  <Box display="flex" justifyContent="center" paddingBottom="10px">
                    <Button
                      color="info"
                      variant="contained"
                      size="small"
                      onClick={() => {
                        setEditSeriesPopup(true);
                        setNewSeriesName(s.name);
                      }}
                    >
                      <p>Edit Series</p>
                    </Button>
                    <div style={{ width: '5px' }} />
                    <Button color="error" variant="contained" size="small" onClick={() => setDeleteSeriesPopup(true)}>
                      <p>Delete Series</p>
                    </Button>
                  </Box>
                  {sermons &&
                    s.sermonIds.map((sermonId) => {
                      return (
                        <div key={sermonId}>
                          <SermonsList
                            sermons={sermons.docs.filter((doc) => doc.data().key === sermonId).map((doc) => doc.data())}
                            minimal={true}
                          />
                        </div>
                      );
                    })}
                </Box>
              </AccordionDetails>
            </Accordion>
          );
        })}
      </Box>
      <EditSeriesComponent
        series={series}
        setSeries={setSeries}
        editSeriesPopup={editSeriesPopup}
        setEditSeriesPopup={setEditSeriesPopup}
        newSeriesName={newSeriesName}
        setNewSeriesName={setNewSeriesName}
        selectedSeries={selectedSeries}
        setSelectedSeries={setSelectedSeries}
      />
      <DeleteEntityPopup
        entityBeingDeleten="series"
        handleDelete={handleSeriesDelete}
        deleteConfirmationPopup={deleteSeriesPopup}
        setDeleteConfirmationPopup={setDeleteSeriesPopup}
      />
    </>
  );
};

AdminSeries.PageLayout = AdminLayout;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  return adminProtected(ctx);
};

export default AdminSeries;
