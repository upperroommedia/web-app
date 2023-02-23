import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import SermonsList from '../../components/SermonsList';
import AdminLayout from '../../layout/adminLayout';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Button from '@mui/material/Button';
import firestore, {
  arrayRemove,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  updateDoc,
} from '../../firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { sermonConverter } from '../../types/Sermon';
import DeleteEntityPopup from '../../components/DeleteEntityPopup';
import { useEffect, useState } from 'react';
import { Series, seriesConverter } from '../../types/Series';
import { GetServerSideProps, GetServerSidePropsContext } from 'next';
import { adminProtected } from '../../utils/protectedRoutes';
import NewSeriesPopup from '../../components/NewSeriesPopup';
import { sanitize } from 'dompurify';
import Image from 'next/image';

const AdminSeries = () => {
  const [series, setSeries] = useState<Series[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<Series>();
  const [editSeriesPopup, setEditSeriesPopup] = useState<boolean>(false);
  const [deleteSeriesPopup, setDeleteSeriesPopup] = useState<boolean>(false);
  const [newSeriesPopup, setNewSeriesPopup] = useState<boolean>(false);

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
          series: arrayRemove(selectedSeries.id),
        });
      });
      setSeries((oldSeries) => oldSeries.filter((series) => series.id !== selectedSeries.id));
    }
  };

  const fetchSeries = async () => {
    const seriesQuery = query(collection(firestore, 'series').withConverter(seriesConverter));
    const seriesQuerySnapshot = await getDocs(seriesQuery);
    setSeries(seriesQuerySnapshot.docs.map((doc) => doc.data()));
  };
  useEffect(() => {
    const g = async () => {
      await fetchSeries();
    };
    g();
  }, []);

  return (
    <>
      <Box padding={3}>
        <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: '5px' }}>
          <h2 style={{ paddingRight: '10px' }}>Manage Series</h2>
          <Button
            color="info"
            variant="contained"
            size="small"
            onClick={() => {
              setNewSeriesPopup(true);
            }}
          >
            <p>Add Series</p>
          </Button>
        </div>
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
                      }}
                    >
                      <p>Edit Series</p>
                    </Button>
                    <div style={{ width: '5px' }} />
                    <Button color="error" variant="contained" size="small" onClick={() => setDeleteSeriesPopup(true)}>
                      <p>Delete Series</p>
                    </Button>
                  </Box>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    {['banner', 'wide', 'square'].map((type, i) => {
                      const image = s.images?.find((image) => image.type === type);
                      return (
                        <div
                          key={image?.id || i}
                          style={{
                            borderRadius: '2px',
                            overflow: 'hidden',
                            position: 'relative',
                            width: 250,
                            height: 250,
                            backgroundColor: image?.averageColorHex || '#f3f1f1',
                            padding: '20px',
                          }}
                        >
                          {image && (
                            <Image
                              src={`${sanitize(image.downloadLink)}`}
                              alt={image.name}
                              style={{
                                objectFit: 'contain',
                                // borderRadius: '5px',
                              }}
                              fill
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
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
      <DeleteEntityPopup
        entityBeingDeleten="series"
        handleDelete={handleSeriesDelete}
        deleteConfirmationPopup={deleteSeriesPopup}
        setDeleteConfirmationPopup={setDeleteSeriesPopup}
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
