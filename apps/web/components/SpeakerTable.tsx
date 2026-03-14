import { ChangeEvent, MouseEvent } from 'react';
import { useRouter } from 'next/router';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import InputAdornment from '@mui/material/InputAdornment';
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
import SearchIcon from '@mui/icons-material/Search';
import Button from '@mui/material/Button';
import AddIcon from '@mui/icons-material/Add';
import CircularProgress from '@mui/material/CircularProgress';
import { visuallyHidden } from '@mui/utils';
import { ISpeaker } from '../types/Speaker';
import { Order } from '../context/types';

interface HeadCell {
  disablePadding: boolean;
  id: keyof ISpeaker;
  label: string;
  numeric: boolean;
}

const headCells: readonly HeadCell[] = [
  { id: 'name', numeric: false, disablePadding: false, label: 'Name' },
  { id: 'sermonCount', numeric: true, disablePadding: false, label: 'Sermon Count' },
  { id: 'listId', numeric: false, disablePadding: false, label: 'List' },
  { id: 'images', numeric: false, disablePadding: false, label: 'Images' },
];

interface SpeakerTableProps {
  speakers: ISpeaker[];
  page: number;
  rowsPerPage: number;
  totalSpeakers: number;
  handlePageChange: (newPage: number) => void;
  handleChangeRowsPerPage: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleSort: (property: keyof ISpeaker, order: Order) => Promise<void>;
  sortOrder: Order;
  setSortOrder: (value: Order) => void;
  sortProperty: keyof ISpeaker;
  setSortProperty: (value: keyof ISpeaker) => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onAddSpeaker: () => void;
  loading?: boolean;
}

const SpeakerTableHead = ({
  order,
  orderBy,
  onRequestSort,
}: {
  order: Order;
  orderBy: string;
  onRequestSort: (event: MouseEvent<HTMLElement>, property: keyof ISpeaker) => void;
}) => {
  const createSortHandler = (property: keyof ISpeaker) => (event: MouseEvent<HTMLElement>) => {
    onRequestSort(event, property);
  };

  return (
    <TableHead>
      <TableRow>
        {headCells.map((headCell) =>
          headCell.id === 'name' || headCell.id === 'sermonCount' ? (
            <TableCell align="center" key={headCell.id} sortDirection={orderBy === headCell.id ? order : false}>
              <TableSortLabel
                onClick={createSortHandler(headCell.id)}
                active={orderBy === headCell.id}
                direction={orderBy === headCell.id ? order : 'asc'}
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
            <TableCell align="center" key={headCell.id}>
              {headCell.label}
            </TableCell>
          )
        )}
      </TableRow>
    </TableHead>
  );
};

const SpeakerTableToolbar = ({
  searchValue,
  onSearchChange,
  onAddSpeaker,
}: {
  searchValue: string;
  onSearchChange: (value: string) => void;
  onAddSpeaker: () => void;
}) => {
  return (
    <Toolbar
      sx={{
        pl: { sm: 2 },
        pr: { xs: 1, sm: 2 },
        gap: 2,
        flexWrap: 'wrap',
      }}
    >
      <Typography variant="h6" id="tableTitle" component="div" sx={{ flexShrink: 0 }}>
        Speakers
      </Typography>
      <TextField
        placeholder="Search speakers by name..."
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
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
      <Button variant="contained" startIcon={<AddIcon />} onClick={onAddSpeaker}>
        Add Speaker
      </Button>
    </Toolbar>
  );
};

const SpeakerTable = ({
  speakers,
  page,
  rowsPerPage,
  totalSpeakers,
  handlePageChange,
  handleChangeRowsPerPage,
  handleSort,
  sortOrder,
  setSortOrder,
  sortProperty,
  setSortProperty,
  searchValue,
  onSearchChange,
  onAddSpeaker,
  loading = false,
}: SpeakerTableProps) => {
  const router = useRouter();

  const handleRequestSort = async (_: MouseEvent<HTMLElement>, property: keyof ISpeaker) => {
    const nextOrder = sortOrder === 'asc' ? 'desc' : 'asc';
    setSortOrder(nextOrder);
    setSortProperty(property);
    await handleSort(property, nextOrder);
  };

  return (
    <Box width={1} display="flex" justifyContent="center">
      <Card sx={{ width: 1 }}>
        <SpeakerTableToolbar
          searchValue={searchValue}
          onSearchChange={onSearchChange}
          onAddSpeaker={onAddSpeaker}
        />
        <TableContainer>
          <Table sx={{ minWidth: 750 }} aria-labelledby="tableTitle" size="medium">
            <SpeakerTableHead order={sortOrder} orderBy={sortProperty} onRequestSort={handleRequestSort} />
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} align="center">
                    <Box display="flex" justifyContent="center" py={4}>
                      <CircularProgress />
                    </Box>
                  </TableCell>
                </TableRow>
              ) : speakers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} align="center">
                    <Typography color="text.secondary" py={4}>
                      {searchValue ? `No speakers found matching "${searchValue}"` : 'No speakers found'}
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                speakers.map((speaker) => (
                    <TableRow
                      hover
                      onClick={() => router.push(`/admin/speakers/${speaker.id}`)}
                      tabIndex={-1}
                      key={speaker.id}
                      sx={{ cursor: 'pointer' }}
                    >
                      <TableCell align="center" component="th" scope="row" padding="none">
                        {speaker.name}
                      </TableCell>
                      <TableCell align="center">{speaker.sermonCount || 0}</TableCell>
                      <TableCell align="center">{speaker.listId || 'No list'}</TableCell>
                      <TableCell>
                        <Box display="flex" justifyContent="center" gap={1}>
                          {['square', 'wide', 'banner'].map((type, index) => {
                            const image = speaker.images?.find((candidate) => candidate.type === type);
                            return (
                              <Box
                                key={image?.id || `${speaker.id}-${type}-${index}`}
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
        <TablePagination
          rowsPerPageOptions={[25, 50, 100]}
          component="div"
          count={totalSpeakers}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={(_, newPage) => handlePageChange(newPage)}
          onRowsPerPageChange={handleChangeRowsPerPage}
        />
      </Card>
    </Box>
  );
};

export default SpeakerTable;
