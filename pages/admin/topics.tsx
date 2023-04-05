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
import { GetServerSideProps, GetServerSidePropsContext } from 'next';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import firestore, { collection } from '../../firebase/firestore';
import AdminLayout from '../../layout/adminLayout';
import { topicConverter } from '../../types/Topic';
import { adminProtected } from '../../utils/protectedRoutes';

const AdminTopics = () => {
  const [topics, loading, error] = useCollectionData(collection(firestore, 'topics').withConverter(topicConverter));

  const formatDateTime = (millis: number) => {
    const date = new Date(millis);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  };

  return (
    <Box display="flex" flexDirection="column" justifyContent="center" alignItems="center" padding={3} width={1}>
      <Typography variant="h2">Manage Topics</Typography>

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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
};

AdminTopics.PageLayout = AdminLayout;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  return adminProtected(ctx);
};

export default AdminTopics;
