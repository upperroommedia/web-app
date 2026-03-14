import { useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Card from '@mui/material/Card';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import Toolbar from '@mui/material/Toolbar';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import SearchIcon from '@mui/icons-material/Search';
import { useCollectionData } from 'react-firebase-hooks/firestore';
import firestore, { collection, orderBy, query } from '../../firebase/firestore';
import AppLayout from '../../layout/AppLayout';
import { topicConverter } from '../../types/Topic';
import Image from 'next/image';

import useAuth from '../../context/user/UserContext';

const AdminTopics = () => {
  const q = query(collection(firestore, 'topics').withConverter(topicConverter), orderBy('title'));
  const [topics, loading, error] = useCollectionData(q);
  const [searchQuery, setSearchQuery] = useState('');

  // Filter topics based on search query
  const filteredTopics = topics?.filter((topic) =>
    !searchQuery || topic.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const formatDateTime = (millis: number) => {
    const date = new Date(millis);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  };

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
      {error ? (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Typography color="error">{`Error: ${error.message}`}</Typography>
        </Box>
      ) : loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
          <CircularProgress />
        </Box>
      ) : (
        <Card>
          <Toolbar sx={{ pl: { sm: 2 }, pr: { xs: 1, sm: 2 }, gap: 2, flexWrap: 'wrap' }}>
            <Typography variant="h6" id="tableTitle" component="div" sx={{ flexShrink: 0 }}>
              Topics
            </Typography>
            <TextField
              placeholder="Search topics by title..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              size="small"
              sx={{ flex: 1, minWidth: 200, maxWidth: 350 }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon color="action" />
                  </InputAdornment>
                ),
              }}
            />
          </Toolbar>
          <TableContainer>
            <Table sx={{ minWidth: 650 }} aria-label="topics table">
              <TableHead>
                <TableRow>
                  <TableCell>Title</TableCell>
                  <TableCell align="center">Items&nbsp;Count</TableCell>
                  <TableCell align="center">Updated&nbsp;At</TableCell>
                  <TableCell align="center">Created&nbsp;At</TableCell>
                  <TableCell align="center">List</TableCell>
                  <TableCell align="center">Images</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredTopics?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} align="center">
                      <Typography color="text.secondary" py={4}>
                        {searchQuery ? `No topics found matching "${searchQuery}"` : 'No topics found'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredTopics?.map((topic) => (
                    <TableRow key={topic.id} sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                      <TableCell component="th" scope="row">
                        <Typography variant="body2" fontWeight={500}>
                          {topic.title}
                        </Typography>
                      </TableCell>
                      <TableCell align="center">
                        <Typography variant="body2" color="text.secondary">
                          {topic.itemsCount}
                        </Typography>
                      </TableCell>
                      <TableCell align="center">
                        <Typography variant="body2" color="text.secondary">
                          {formatDateTime(topic.updatedAtMillis)}
                        </Typography>
                      </TableCell>
                      <TableCell align="center">
                        <Typography variant="body2" color="text.secondary">
                          {formatDateTime(topic.createdAtMillis)}
                        </Typography>
                      </TableCell>
                      <TableCell align="center">
                        <Typography variant="body2" color="text.secondary">
                          {topic.listId || 'No list'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Box display="flex" justifyContent="center" gap={1}>
                          {['square', 'wide', 'banner'].map((type, i) => {
                            const image = topic.images?.find((image) => image.type === type);
                            return (
                              <Box
                                key={image?.id || i}
                                sx={{
                                  borderRadius: 1,
                                  overflow: 'hidden',
                                  position: 'relative',
                                  width: 44,
                                  height: 44,
                                  bgcolor: image?.averageColorHex || 'background.default',
                                  border: '1px solid',
                                  borderColor: 'divider',
                                }}
                              >
                                {image && (
                                  <Image
                                    src={image.downloadLink}
                                    alt={`Image of ${image.name}`}
                                    width={44}
                                    height={44}
                                    style={{ objectFit: 'contain' }}
                                  />
                                )}
                              </Box>
                            );
                          })}
                        </Box>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}
    </Box>
  );
};

const ProtectedAdminTopics = () => {
  const { user } = useAuth();
  if (!user?.isAdmin()) {
    return null;
  } else {
    return <AdminTopics />;
  }
};

ProtectedAdminTopics.PageLayout = AppLayout;

export default ProtectedAdminTopics;
