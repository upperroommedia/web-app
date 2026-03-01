import { ChangeEvent, ReactNode, memo, useState } from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import SearchIcon from '@mui/icons-material/Search';
import { visuallyHidden } from '@mui/utils';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import { Order, ROLES } from '../context/types';
import { User, UserWithLoading } from '../types/User';
import useAuth from '../context/user/UserContext';
import FormControl from '@mui/material/FormControl';
import CircularProgress from '@mui/material/CircularProgress';

const stableSort = <T extends User>(array: T[], order: Order, orderBy: keyof T) => {
  function compareEmail(a: T, b: T) {
    if (a.email && b.email) {
      return a.email.localeCompare(b.email);
    } else if (a.email) {
      return 1;
    } else if (b.email) {
      return -1;
    }
    return 0;
  }

  function compareOtherColumn(a: T, b: T) {
    if (a.role && b.role) {
      const comparison = a.role?.localeCompare(b.role);
      if (comparison === 0) {
        return compareEmail(a, b);
      }
      return comparison;
    } else if (a.role) return 1;
    else if (b.role) return -1;
    return 0;
  }

  if (orderBy === 'email') {
    return order === 'asc' ? array.sort((a, b) => compareEmail(a, b)) : array.sort((a, b) => compareEmail(b, a));
  } else if (orderBy === 'role') {
    array.sort((a, b) => {
      return order === 'asc' ? compareOtherColumn(a, b) : compareOtherColumn(b, a);
    });
  }
  return array;
};

interface HeadCell {
  disablePadding: boolean;
  id: keyof User;
  label: string;
  numeric: boolean;
}

const headCells: readonly HeadCell[] = [
  {
    id: 'email',
    numeric: false,
    disablePadding: false,
    label: 'Email',
  },
  {
    id: 'role',
    numeric: false,
    disablePadding: false,
    label: 'Role',
  },
  {
    id: 'photoURL',
    numeric: false,
    disablePadding: false,
    label: 'Photo',
  },
];

interface UserTableProps {
  onRequestSort: (event: any, property: keyof User) => void;
  order: Order;
  orderBy: string;
  rowCount: number;
}

const UserTableHead = (props: UserTableProps) => {
  const { order, orderBy, onRequestSort } = props;
  const createSortHandler = (property: keyof User) => (event: any) => {
    onRequestSort(event, property);
  };

  return (
    <TableHead>
      <TableRow>
        {headCells.map((headCell) =>
          headCell.id !== 'photoURL' ? (
            <TableCell
              align="center"
              // width={`${100 / 3}%`}
              // sx={{ minWidth: '200px' }}
              key={headCell.id}
              sortDirection={orderBy === headCell.id ? order : false}
            >
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
            <TableCell align="center" key={headCell.id} sortDirection={orderBy === headCell.id ? order : false}>
              {headCell.label}
            </TableCell>
          )
        )}
      </TableRow>
    </TableHead>
  );
};

interface UserTableToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  actions?: ReactNode;
}

const UserTableToolbar = ({ searchValue, onSearchChange, actions }: UserTableToolbarProps) => {
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
        Users
      </Typography>
      <TextField
        placeholder="Search users by email..."
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
      {actions && <Box sx={{ flexShrink: 0 }}>{actions}</Box>}
    </Toolbar>
  );
};

const UserTable = (props: {
  usersWithLoading: UserWithLoading[];
  handleRoleChange: (uid: string, role: string) => Promise<void>;
  loading: boolean;
  toolbarActions?: ReactNode;
}) => {
  const [order, setOrder] = useState<Order>('asc');
  const [orderBy, setOrderBy] = useState<keyof User>('email');
  const { user: currentUser } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');

  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  // Filter users based on search query
  const filteredUsers = props.usersWithLoading.filter((user) =>
    !searchQuery || 
    user.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.displayName?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleRequestSort = (_: any, property: keyof User) => {
    const isAsc = order === 'asc';
    setOrder(isAsc ? 'desc' : 'asc');
    setOrderBy(property);
  };

  const handleChangePage = (event: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event: ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  // Avoid a layout jump when reaching the last page with empty rows.
  const emptyRows = page > 0 ? Math.max(0, (1 + page) * rowsPerPage - filteredUsers.length) : 0;
  return (
    <Box width={1} display="flex" justifyContent="center">
      <Card sx={{ width: 1 }}>
        <UserTableToolbar searchValue={searchQuery} onSearchChange={setSearchQuery} actions={props.toolbarActions} />
        <TableContainer>
          <Table aria-labelledby="tableTitle" size={'medium'}>
            <UserTableHead
              order={order}
              orderBy={orderBy}
              onRequestSort={handleRequestSort}
              rowCount={filteredUsers.length}
            />
            <TableBody>
              {props.loading ? (
                <TableRow>
                  <TableCell rowSpan={3} colSpan={3}>
                    <Box display="flex" justifyContent="center" alignContent="center" py={4}>
                      <CircularProgress />
                    </Box>
                  </TableCell>
                </TableRow>
              ) : filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} align="center">
                    <Typography color="text.secondary" py={4}>
                      {searchQuery ? `No users found matching "${searchQuery}"` : 'No users found'}
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                stableSort(filteredUsers, order, orderBy)
                  .slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)
                  .map((user) => {
                    const displayName = user.displayName || user.email;
                    return (
                      <TableRow hover tabIndex={-1} key={user.uid}>
                        <TableCell align="center">{user.email}</TableCell>
                        <TableCell align="center">
                          {currentUser?.uid === user.uid ? (
                            <Typography>{user.role}</Typography>
                          ) : (
                            <FormControl disabled={user.loading} size="small">
                              <Select
                                value={user.role}
                                onChange={async (e) => {
                                  await props.handleRoleChange(user.uid, e.target.value);
                                }}
                              >
                                {ROLES.map((role) => (
                                  <MenuItem key={role} value={role}>
                                    <Box
                                      sx={{
                                        display: 'flex',
                                        justifyContent: 'center',
                                        alignItems: 'center',
                                        gap: 2,
                                        minWidth: 75,
                                      }}
                                    >
                                      {user.loading ? <CircularProgress size={20} color="inherit" /> : role}
                                    </Box>
                                  </MenuItem>
                                ))}
                              </Select>
                            </FormControl>
                          )}
                        </TableCell>
                        <TableCell align="center">
                          <Box
                            sx={{
                              mx: 'auto',
                              borderRadius: 1,
                              overflow: 'hidden',
                              position: 'relative',
                              width: 44,
                              height: 44,
                              bgcolor: 'background.default',
                              border: '1px solid',
                              borderColor: 'divider',
                            }}
                          >
                            <Image
                              src={user.photoURL || '/user.png'}
                              alt={`Image of ${displayName}`}
                              fill
                              style={{ objectFit: 'cover' }}
                            />
                          </Box>
                        </TableCell>
                      </TableRow>
                    );
                  })
              )}
              {emptyRows > 0 && (
                <TableRow style={{ height: 53 * emptyRows }}>
                  <TableCell colSpan={6} />
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          rowsPerPageOptions={[25, 50, 100]}
          component="div"
          count={filteredUsers.length}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={handleChangePage}
          onRowsPerPageChange={handleChangeRowsPerPage}
        />
      </Card>
    </Box>
  );
};

function userTablesAreEqual(
  prevProps: { usersWithLoading: UserWithLoading[]; loading: boolean; toolbarActions?: ReactNode },
  nextProps: { usersWithLoading: UserWithLoading[]; loading: boolean; toolbarActions?: ReactNode }
) {
  return (
    prevProps.loading === nextProps.loading &&
    JSON.stringify(prevProps.usersWithLoading) === JSON.stringify(nextProps.usersWithLoading)
  );
}

export default memo(UserTable, userTablesAreEqual);
