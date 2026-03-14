import { ChangeEvent, MouseEvent } from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import InputAdornment from '@mui/material/InputAdornment';
import LinearProgress from '@mui/material/LinearProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import SearchIcon from '@mui/icons-material/Search';
import { visuallyHidden } from '@mui/utils';
import { Order } from '../context/types';
import { Topic } from '../types/Topic';

interface HeadCell {
  id: keyof Topic | 'images';
  label: string;
  width: string;
}

const headCells: readonly HeadCell[] = [
  { id: 'title', label: 'Title', width: '34%' },
  { id: 'itemsCount', label: 'Items', width: '14%' },
  { id: 'listId', label: 'List', width: '24%' },
  { id: 'images', label: 'Images', width: '28%' },
];

interface TopicTableProps {
  topics: Topic[];
  page: number;
  rowsPerPage: number;
  totalTopics: number;
  sortOrder: Order;
  sortProperty: keyof Topic;
  searchValue: string;
  loading?: boolean;
  handlePageChange: (newPage: number) => void;
  handleChangeRowsPerPage: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleSort: (property: keyof Topic, order: Order) => Promise<void>;
  onSearchChange: (value: string) => void;
}

const TopicTableHead = ({
  order,
  orderBy,
  onRequestSort,
}: {
  order: Order;
  orderBy: string;
  onRequestSort: (event: MouseEvent<HTMLElement>, property: keyof Topic) => void;
}) => {
  const createSortHandler = (property: keyof Topic) => (event: MouseEvent<HTMLElement>) => {
    onRequestSort(event, property);
  };

  return (
    <TableHead>
      <TableRow>
        {headCells.map((headCell) =>
          headCell.id === 'title' || headCell.id === 'itemsCount' ? (
            <TableCell
              key={headCell.id}
              align="center"
              sortDirection={orderBy === headCell.id ? order : false}
              sx={{ width: headCell.width }}
            >
              <TableSortLabel
                active={orderBy === headCell.id}
                direction={orderBy === headCell.id ? order : 'asc'}
                hideSortIcon={false}
                onClick={createSortHandler(headCell.id)}
              >
                {headCell.label}
                {orderBy === headCell.id ? (
                  <Box component="span" sx={visuallyHidden}>
                    {order === 'desc' ? 'sorted descending' : 'sorted ascending'}
                  </Box>
                ) : null}
              </TableSortLabel>
            </TableCell>
          ) : (
            <TableCell key={headCell.id} align="center" sx={{ width: headCell.width }}>
              {headCell.label}
            </TableCell>
          )
        )}
      </TableRow>
    </TableHead>
  );
};

const TopicTable = ({
  topics,
  page,
  rowsPerPage,
  totalTopics,
  sortOrder,
  sortProperty,
  searchValue,
  loading = false,
  handlePageChange,
  handleChangeRowsPerPage,
  handleSort,
  onSearchChange,
}: TopicTableProps) => {
  const showInitialLoadingState = loading && topics.length === 0;
  const showBackgroundLoadingState = loading && topics.length > 0;

  const handleRequestSort = async (_: MouseEvent<HTMLElement>, property: keyof Topic) => {
    const nextOrder =
      sortProperty === property ? (sortOrder === 'asc' ? 'desc' : 'asc') : property === 'itemsCount' ? 'desc' : 'asc';
    await handleSort(property, nextOrder);
  };

  return (
    <Box width={1} display="flex" justifyContent="center">
      <Card sx={{ width: 1 }}>
        <Toolbar
          sx={{
            pl: { sm: 2 },
            pr: { xs: 1, sm: 2 },
            gap: 2,
            flexWrap: 'wrap',
          }}
        >
          <Typography variant="h6" id="tableTitle" component="div" sx={{ flexShrink: 0 }}>
            Topics
          </Typography>
          <TextField
            placeholder="Search topics by title..."
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            size="small"
            sx={{ flex: 1, minWidth: 220, maxWidth: 360 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon color="action" />
                </InputAdornment>
              ),
            }}
          />
        </Toolbar>
        <Box position="relative">
          {showBackgroundLoadingState ? (
            <LinearProgress
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 2,
                pointerEvents: 'none',
              }}
            />
          ) : null}
          <TableContainer>
            <Table sx={{ minWidth: 760, tableLayout: 'fixed' }} aria-labelledby="tableTitle" size="medium">
              <TopicTableHead order={sortOrder} orderBy={sortProperty} onRequestSort={handleRequestSort} />
              <TableBody>
                {showInitialLoadingState ? (
                  <TableRow>
                    <TableCell colSpan={4} align="center">
                      <Box display="flex" justifyContent="center" py={4}>
                        <CircularProgress />
                      </Box>
                    </TableCell>
                  </TableRow>
                ) : topics.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} align="center">
                      <Typography color="text.secondary" py={4}>
                        {searchValue ? `No topics found matching "${searchValue}"` : 'No topics found'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  topics.map((topic) => (
                    <TableRow key={topic.id}>
                      <TableCell
                        align="center"
                        sx={{
                          width: headCells[0].width,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {topic.title}
                      </TableCell>
                      <TableCell align="center" sx={{ width: headCells[1].width }}>
                        {topic.itemsCount}
                      </TableCell>
                      <TableCell
                        align="center"
                        sx={{
                          width: headCells[2].width,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {topic.listId || 'No list'}
                      </TableCell>
                      <TableCell sx={{ width: headCells[3].width }}>
                        <Box display="flex" justifyContent="center" gap={1}>
                          {['square', 'wide', 'banner'].map((type, index) => {
                            const image = topic.images?.find((candidate) => candidate.type === type);
                            return (
                              <Box
                                key={image?.id || `${topic.id}-${type}-${index}`}
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
        </Box>
        <TablePagination
          rowsPerPageOptions={[25, 50, 100]}
          component="div"
          count={totalTopics}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={(_, newPage) => handlePageChange(newPage)}
          onRowsPerPageChange={handleChangeRowsPerPage}
        />
      </Card>
    </Box>
  );
};

export default TopicTable;
