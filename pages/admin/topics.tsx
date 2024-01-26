import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import firestore, { collection, orderBy, query } from '../../firebase/firestore';
import AdminLayout from '../../layout/adminLayout';
import { topicConverter } from '../../types/Topic';
// import { adminProtected } from '../../utils/protectedRoutes';
import Image from 'next/image';
import { sanitize } from 'dompurify';
import useAuth from '../../context/user/UserContext';

const AdminTopics = () => {
  const q = query(collection(firestore, 'topics').withConverter(topicConverter), orderBy('title'));
  const [topics, loading, error] = useCollectionData(q);

  const formatDateTime = (millis: number) => {
    const date = new Date(millis);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  };

  return (
    <Box display="flex" flexDirection="column" justifyContent="center" alignItems="center" padding={3} width={1}>
      <Typography variant="h4">Manage Topics</Typography>

      {error ? (
        <Typography color="red">{`Error: ${error.message}`}</Typography>
      ) : loading ? (
        <CircularProgress />
      ) : (
        <TableContainer component={Paper}>
          <Table sx={{ minWidth: 650 }} aria-label="simple table">
            <TableHead>
              <TableRow>
                <TableCell align="center">Title</TableCell>
                <TableCell align="center">Items&nbsp;Count</TableCell>
                <TableCell align="center">Updated&nbsp;At</TableCell>
                <TableCell align="center">Created&nbsp;At</TableCell>
                <TableCell align="center">List</TableCell>
                <TableCell align="center">Images</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {topics?.map((topic) => (
                <TableRow key={topic.id} sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                  <TableCell align="center" component="th" scope="row">
                    {topic.title}
                  </TableCell>
                  <TableCell align="center">{topic.itemsCount}</TableCell>
                  <TableCell align="center">{formatDateTime(topic.updatedAtMillis)}</TableCell>
                  <TableCell align="center">{formatDateTime(topic.createdAtMillis)}</TableCell>
                  <TableCell align="center">{topic.listId || 'No list'}</TableCell>
                  <TableCell style={{ display: 'flex', gap: '10px', justifyContent: 'start' }}>
                    <Box
                      display="flex"
                      justifyContent="center"
                      gap={1}
                      sx={{ marginLeft: 'auto', marginRight: 'auto' }}
                    >
                      {['square', 'wide', 'banner'].map((type, i) => {
                        const image = topic.images?.find((image) => image.type === type);
                        return (
                          <div
                            key={image?.id || i}
                            style={{
                              borderRadius: '2px',
                              overflow: 'hidden',
                              position: 'relative',
                              width: 50,
                              height: 50,
                              backgroundColor: image?.averageColorHex || '#f3f1f1',
                            }}
                          >
                            {image && (
                              <Image
                                src={sanitize(image.downloadLink)}
                                alt={`Image of ${image.name}`}
                                width={50}
                                height={50}
                                style={{ objectFit: 'contain' }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </Box>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
};

// export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
//   return adminProtected(ctx);
// };

const ProtectedAdminTopics = () => {
  const { user } = useAuth();
  if (!user?.isAdmin()) {
    return null;
  } else {
    return <AdminTopics />;
  }
};

ProtectedAdminTopics.PageLayout = AdminLayout;

export default ProtectedAdminTopics;
