import { ChangeEvent, useState } from 'react';
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
import { User } from '../pages/admin';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import { ROLES } from '../context/types';

type Order = 'asc' | 'desc';

const stableSort = (array: User[], order: Order, orderBy: keyof User) => {
  if (orderBy === 'email') {
    return order === 'asc'
      ? array.sort((a, b) => a.email.localeCompare(b.email))
      : array.sort((a, b) => b.email.localeCompare(a.email));
  } else if (orderBy === 'role') {
    array.sort((a, b) => {
      if (
        (a.role === 'admin' && (b.role === 'user' || b.role === 'uploader')) ||
        (a.role === 'uploader' && b.role === 'user')
      ) {
        return order === 'asc' ? 1 : -1;
      } else if (
        (b.role === 'admin' && (a.role === 'user' || a.role === 'uploader')) ||
        (b.role === 'uploader' && a.role === 'user')
      ) {
        return order === 'asc' ? 1 : -1;
      } else return 0;
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
            <TableCell key={headCell.id} sortDirection={orderBy === headCell.id ? order : false}>
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
            <TableCell key={headCell.id} sortDirection={orderBy === headCell.id ? order : false}>
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

const UserTable = (props: { users: User[]; handleRoleChange: (email: string, role: string) => void }) => {
  const [order, setOrder] = useState<Order>('asc');
  const [orderBy, setOrderBy] = useState<keyof User>('email');

  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(5);

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
  const emptyRows = page > 0 ? Math.max(0, (1 + page) * rowsPerPage - props.users.length) : 0;

  return (
    <>
      <Box sx={{ width: '100%' }}>
        <Paper sx={{ width: '100%', mb: 2 }}>
          <UserTableToolbar />
          <TableContainer>
            <Table sx={{ minWidth: 750 }} aria-labelledby="tableTitle" size={'medium'}>
              <UserTableHead
                order={order}
                orderBy={orderBy}
                onRequestSort={handleRequestSort}
                rowCount={props.users.length}
              />
              <TableBody>
                {/* if you don't need to support IE11, you can replace the `stableSort` call with:
              rows.sort(getComparator(order, orderBy)).slice() */}
                {stableSort(props.users, order, orderBy)
                  .slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)
                  .map((user) => {
                    return (
                      <TableRow hover tabIndex={-1} key={user.uid}>
                        <TableCell>{user.email}</TableCell>
                        <TableCell>
                          <div style={{ display: 'flex', padding: '20px', gap: '10px' }}>
                            <Select
                              labelId="demo-simple-select-label"
                              id="demo-simple-select"
                              value={user.role}
                              onChange={(e) => props.handleRoleChange(user.email, e.target.value)}
                            >
                              {ROLES.map((role) => (
                                <MenuItem key={role} value={role}>
                                  {role}
                                </MenuItem>
                              ))}
                            </Select>
                          </div>
                        </TableCell>
                        <TableCell align="right">
                          <div
                            style={{
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
                            {user.photoURL && <Image src={user.photoURL} layout="fill" />}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
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
            rowsPerPageOptions={[5, 10, 25]}
            component="div"
            count={props.users.length}
            rowsPerPage={rowsPerPage}
            page={page}
            onPageChange={handleChangePage}
            onRowsPerPageChange={handleChangeRowsPerPage}
          />
        </Paper>
      </Box>
    </>
  );
};

export default UserTable;