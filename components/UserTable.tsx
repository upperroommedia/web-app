import { ChangeEvent, memo, useState } from 'react';
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
import Paper from '@mui/material/Paper';
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

  if (orderBy === 'email') {
    return order === 'desc' ? array.sort((a, b) => compareEmail(a, b)) : array.sort((a, b) => compareEmail(b, a));
  } else if (orderBy === 'role') {
    array.sort((a, b) => {
      if (a.role && b.role) {
        return order === 'desc' ? a.role.localeCompare(b.role) : b.role.localeCompare(a.role);
      } else if (a.role) {
        return order === 'desc' ? 1 : -1;
      } else if (b.role) {
        return order === 'desc' ? -1 : 1;
      }
      return 0;
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

const UserTableToolbar = () => {
  return (
    <Toolbar
      sx={{
        pl: { sm: 2 },
        pr: { xs: 1, sm: 1 },
      }}
    >
      <Typography sx={{ flex: '1 1 100%' }} variant="h6" id="tableTitle" component="div">
        Users
      </Typography>
    </Toolbar>
  );
};

const UserTable = (props: {
  usersWithLoading: UserWithLoading[];
  handleRoleChange: (uid: string, role: string) => Promise<void>;
  loading: boolean;
}) => {
  const [order, setOrder] = useState<Order>('asc');
  const [orderBy, setOrderBy] = useState<keyof User>('email');
  const { user: currentUser } = useAuth();

  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

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
  const emptyRows = page > 0 ? Math.max(0, (1 + page) * rowsPerPage - props.usersWithLoading.length) : 0;
  return (
    <Box width={1} maxWidth={800} display="flex" padding="30px" justifyContent="center">
      <Paper
        sx={{
          width: 1,
        }}
      >
        <UserTableToolbar />
        <TableContainer>
          <Table aria-labelledby="tableTitle" size={'medium'}>
            <UserTableHead
              order={order}
              orderBy={orderBy}
              onRequestSort={handleRequestSort}
              rowCount={props.usersWithLoading.length}
            />
            <TableBody>
              {/* if you don't need to support IE11, you can replace the `stableSort` call with:
                rows.sort(getComparator(order, orderBy)).slice() */}
              {props.loading ? (
                <TableRow>
                  <TableCell rowSpan={3} colSpan={3}>
                    <Box display="flex" justifyContent="center" alignContent="center">
                      <CircularProgress />
                    </Box>
                  </TableCell>
                </TableRow>
              ) : (
                stableSort(props.usersWithLoading, order, orderBy)
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
                            <FormControl disabled={user.loading}>
                              <Select
                                labelId="demo-simple-select-label"
                                id="demo-simple-select"
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
                                        gap: '16px',
                                        minWidth: '75px',
                                      }}
                                    >
                                      {user.loading ? <CircularProgress size={24} color="inherit" /> : role}
                                    </Box>
                                  </MenuItem>
                                ))}
                              </Select>
                            </FormControl>
                          )}
                        </TableCell>
                        <TableCell align="center">
                          <div
                            style={{
                              margin: 'auto',
                              borderRadius: '2px',
                              overflow: 'hidden',
                              position: 'relative',
                              width: 50,
                              height: 50,
                              backgroundImage: `url(${'/user.png'})`,
                              backgroundPosition: 'center center',
                              backgroundSize: 'cover',
                            }}
                          >
                            {user.photoURL && <Image src={user.photoURL} alt={`Image of ${displayName}`} fill />}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
              )}
              {emptyRows > 0 && (
                <TableRow
                  style={{
                    height: 53 * emptyRows,
                  }}
                >
                  <TableCell colSpan={6} />
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          rowsPerPageOptions={[25, 50, 100]}
          component="div"
          count={props.usersWithLoading.length}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={handleChangePage}
          onRowsPerPageChange={handleChangeRowsPerPage}
        />
      </Paper>
    </Box>
  );
};

function userTablesAreEqual(
  prevProps: { usersWithLoading: UserWithLoading[]; loading: boolean },
  nextProps: { usersWithLoading: UserWithLoading[]; loading: boolean }
) {
  return (
    prevProps.loading === nextProps.loading &&
    JSON.stringify(prevProps.usersWithLoading) === JSON.stringify(nextProps.usersWithLoading)
  );
}

export default memo(UserTable, userTablesAreEqual);
