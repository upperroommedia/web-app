import { ChangeEvent, MouseEvent } from 'react';
import { useRouter } from 'next/router';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
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
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CircularProgress from '@mui/material/CircularProgress';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import SearchIcon from '@mui/icons-material/Search';
import { visuallyHidden } from '@mui/utils';
import { Order } from '../context/types';
import { List, ListType } from '../types/List';
import { getDefaultListSortOrder, isListSortableProperty } from '../utils/algolia/listSorting';

interface HeadCell {
  id: keyof List | 'actions';
  label: string;
  width: string;
}

const headCells: readonly HeadCell[] = [
  { id: 'name', label: 'Name', width: '34%' },
  { id: 'count', label: 'Items', width: '14%' },
  { id: 'type', label: 'Type', width: '16%' },
  { id: 'images', label: 'Images', width: '20%' },
  { id: 'actions', label: 'Actions', width: '16%' },
];

interface ListTableProps {
  lists: List[];
  page: number;
  rowsPerPage: number;
  totalLists: number;
  sortOrder: Order;
  sortProperty: keyof List;
  searchValue: string;
  listTypeFilter: ListType | '';
  loading?: boolean;
  handlePageChange: (newPage: number) => void;
  handleChangeRowsPerPage: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleSort: (property: keyof List, order: Order) => Promise<void>;
  onSearchChange: (value: string) => void;
  onFilterChange: (value: ListType | '') => void;
  onAddList: () => void;
  onEditList: (list: List) => void;
  onDeleteList: (list: List) => void;
  disableButtons?: boolean;
  listTypeOptions: Record<ListType, string>;
}

const ListTableHead = ({
  order,
  orderBy,
  onRequestSort,
}: {
  order: Order;
  orderBy: string;
  onRequestSort: (event: MouseEvent<HTMLElement>, property: keyof List) => void;
}) => {
  const createSortHandler = (property: keyof List) => (event: MouseEvent<HTMLElement>) => {
    onRequestSort(event, property);
  };

  return (
    <TableHead>
      <TableRow>
        {headCells.map((headCell) =>
          headCell.id === 'name' || headCell.id === 'count' ? (
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

const ListTable = ({
  lists,
  page,
  rowsPerPage,
  totalLists,
  sortOrder,
  sortProperty,
  searchValue,
  listTypeFilter,
  loading = false,
  handlePageChange,
  handleChangeRowsPerPage,
  handleSort,
  onSearchChange,
  onFilterChange,
  onAddList,
  onEditList,
  onDeleteList,
  disableButtons = false,
  listTypeOptions,
}: ListTableProps) => {
  const router = useRouter();
  const showInitialLoadingState = loading && lists.length === 0;
  const showBackgroundLoadingState = loading && lists.length > 0;

  const handleRequestSort = async (_: MouseEvent<HTMLElement>, property: keyof List) => {
    const nextOrder =
      sortProperty === property
        ? sortOrder === 'asc'
          ? 'desc'
          : 'asc'
        : isListSortableProperty(property)
        ? getDefaultListSortOrder(property)
        : 'asc';
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
            Lists
          </Typography>
          <TextField
            placeholder="Search lists by name..."
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
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel id="list-type-filter-label">Type</InputLabel>
            <Select
              labelId="list-type-filter-label"
              label="Type"
              value={listTypeFilter}
              onChange={(event) => onFilterChange(event.target.value as ListType | '')}
            >
              <MenuItem value="">All Types</MenuItem>
              {(Object.values(ListType) as Array<ListType>).map((listType) =>
                listType !== ListType.LATEST ? (
                  <MenuItem key={listType} value={listType}>
                    {listTypeOptions[listType]}
                  </MenuItem>
                ) : null
              )}
            </Select>
          </FormControl>
          <Button variant="contained" startIcon={<AddIcon />} onClick={onAddList}>
            Add List
          </Button>
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
            <Table sx={{ minWidth: 850, tableLayout: 'fixed' }} aria-labelledby="tableTitle" size="medium">
              <ListTableHead order={sortOrder} orderBy={sortProperty} onRequestSort={handleRequestSort} />
              <TableBody>
                {showInitialLoadingState ? (
                  <TableRow>
                    <TableCell colSpan={5} align="center">
                      <Box display="flex" justifyContent="center" py={4}>
                        <CircularProgress />
                      </Box>
                    </TableCell>
                  </TableRow>
                ) : lists.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} align="center">
                      <Typography color="text.secondary" py={4}>
                        {searchValue || listTypeFilter
                          ? 'No lists found matching the current filters'
                          : 'No lists found'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  lists.map((list) => (
                    <TableRow
                      hover
                      key={list.id}
                      onClick={() => router.push(`/admin/lists/${list.id}?count=${list.count || 20}`)}
                      sx={{ cursor: 'pointer' }}
                    >
                      <TableCell
                        align="center"
                        sx={{
                          width: headCells[0].width,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {list.name}
                      </TableCell>
                      <TableCell align="center" sx={{ width: headCells[1].width }}>
                        {list.count ?? 0}
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
                        {listTypeOptions[list.type] || list.type}
                      </TableCell>
                      <TableCell sx={{ width: headCells[3].width }}>
                        <Box display="flex" justifyContent="center" gap={1}>
                          {['square', 'wide', 'banner'].map((type, index) => {
                            const image = list.images?.find((candidate) => candidate.type === type);
                            return (
                              <Box
                                key={image?.id || `${list.id}-${type}-${index}`}
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
                      <TableCell align="center" sx={{ width: headCells[4].width }}>
                        <Tooltip title="Edit List">
                          <span>
                            <IconButton
                              disabled={disableButtons}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onEditList(list);
                              }}
                            >
                              <EditIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Delete List">
                          <span>
                            <IconButton
                              disabled={disableButtons}
                              color="error"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onDeleteList(list);
                              }}
                            >
                              <DeleteIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
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
          count={totalLists}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={(_, newPage) => handlePageChange(newPage)}
          onRowsPerPageChange={handleChangeRowsPerPage}
        />
      </Card>
    </Box>
  );
};

export default ListTable;
