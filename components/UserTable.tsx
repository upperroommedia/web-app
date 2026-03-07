import { ChangeEvent, ReactNode, memo, useState } from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import InputAdornment from '@mui/material/InputAdornment';
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
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';
import { visuallyHidden } from '@mui/utils';
import { Order, ROLES } from '../context/types';
import useAuth from '../context/user/UserContext';
import { UserWithLoading } from '../types/User';

type SortKey = 'name' | 'username' | 'email' | 'provider' | 'joined' | 'lastSignIn' | 'role';

interface HeadCell {
  id: SortKey;
  label: string;
}

const headCells: readonly HeadCell[] = [
  { id: 'name', label: 'Name' },
  { id: 'username', label: 'Username' },
  { id: 'email', label: 'Email' },
  { id: 'provider', label: 'Provider' },
  { id: 'joined', label: 'Joined' },
  { id: 'lastSignIn', label: 'Last Sign In' },
  { id: 'role', label: 'Role' },
];

const getDisplayName = (user: UserWithLoading): string => {
  const mergedName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  if (user.displayName?.trim()) {
    return user.displayName.trim();
  }
  if (mergedName.length > 0) {
    return mergedName;
  }
  return '--';
};

const getUsername = (user: UserWithLoading): string => {
  if (!user.email) {
    return '--';
  }
  const [username] = user.email.split('@');
  return username?.trim().length ? username : '--';
};

const getPrimaryProviderId = (user: UserWithLoading): string => {
  const providerId = user.providerData?.[0]?.providerId ?? '';
  return providerId.trim().length ? providerId : '--';
};

const formatProviderLabel = (providerId: string): string => {
  switch (providerId) {
    case 'google.com':
      return 'Google';
    case 'password':
      return 'Email/Password';
    case 'apple.com':
      return 'Apple';
    case 'microsoft.com':
      return 'Microsoft';
    case '--':
      return '--';
    default:
      return providerId;
  }
};

const parseMetadataDate = (value: string | undefined | null): number => {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatMetadataDate = (value: string | undefined | null): string => {
  const parsed = parseMetadataDate(value);
  return parsed > 0 ? new Date(parsed).toLocaleString() : '--';
};

const getSortValue = (user: UserWithLoading, key: SortKey): string | number => {
  switch (key) {
    case 'name':
      return getDisplayName(user).toLowerCase();
    case 'username':
      return getUsername(user).toLowerCase();
    case 'email':
      return (user.email ?? '--').toLowerCase();
    case 'provider':
      return formatProviderLabel(getPrimaryProviderId(user)).toLowerCase();
    case 'joined':
      return parseMetadataDate(user.metadata?.creationTime);
    case 'lastSignIn':
      return parseMetadataDate(user.metadata?.lastSignInTime);
    case 'role':
      return (user.role ?? 'unassigned').toLowerCase();
    default:
      return '';
  }
};

const compareValues = (a: string | number, b: string | number): number => {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b));
};

const stableSort = (array: UserWithLoading[], order: Order, orderBy: SortKey): UserWithLoading[] =>
  [...array].sort((a, b) => {
    const comparison = compareValues(getSortValue(a, orderBy), getSortValue(b, orderBy));
    return order === 'asc' ? comparison : -comparison;
  });

interface UserTableHeadProps {
  onRequestSort: (_event: React.MouseEvent<unknown>, property: SortKey) => void;
  order: Order;
  orderBy: SortKey;
}

const UserTableHead = ({ order, orderBy, onRequestSort }: UserTableHeadProps) => {
  const createSortHandler = (property: SortKey) => (event: React.MouseEvent<unknown>) => {
    onRequestSort(event, property);
  };

  return (
    <TableHead>
      <TableRow>
        <TableCell align="center">Image</TableCell>
        {headCells.map((headCell) => (
          <TableCell key={headCell.id} align="center" sortDirection={orderBy === headCell.id ? order : false}>
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
        ))}
      </TableRow>
    </TableHead>
  );
};

interface UserTableToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  actions?: ReactNode;
}

const UserTableToolbar = ({ searchValue, onSearchChange, actions }: UserTableToolbarProps) => (
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
      placeholder="Search by name, username, or email..."
      value={searchValue}
      onChange={(event) => onSearchChange(event.target.value)}
      size="small"
      sx={{ flex: 1, minWidth: 220, maxWidth: 400 }}
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

const COLUMN_COUNT = headCells.length + 1;

const UserTable = (props: {
  usersWithLoading: UserWithLoading[];
  handleRoleChange: (uid: string, role: string) => Promise<void>;
  loading: boolean;
  toolbarActions?: ReactNode;
}) => {
  const [order, setOrder] = useState<Order>('asc');
  const [orderBy, setOrderBy] = useState<SortKey>('email');
  const { user: currentUser } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredUsers = props.usersWithLoading.filter((user) => {
    if (normalizedSearch.length === 0) {
      return true;
    }

    const searchFields = [
      getDisplayName(user),
      getUsername(user),
      user.email ?? '',
      formatProviderLabel(getPrimaryProviderId(user)),
      user.uid,
    ];
    return searchFields.some((field) => field.toLowerCase().includes(normalizedSearch));
  });

  const sortedUsers = stableSort(filteredUsers, order, orderBy);

  const handleRequestSort = (_: React.MouseEvent<unknown>, property: SortKey) => {
    const isAsc = orderBy === property && order === 'asc';
    setOrder(isAsc ? 'desc' : 'asc');
    setOrderBy(property);
  };

  const handleChangePage = (_event: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event: ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const paginatedUsers = sortedUsers.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  const emptyRows = page > 0 ? Math.max(0, (1 + page) * rowsPerPage - filteredUsers.length) : 0;

  return (
    <Box width={1} display="flex" justifyContent="center">
      <Card sx={{ width: 1 }}>
        <UserTableToolbar searchValue={searchQuery} onSearchChange={setSearchQuery} actions={props.toolbarActions} />
        <TableContainer sx={{ overflowX: 'auto', overflowY: 'hidden' }}>
          <Table aria-labelledby="tableTitle" size="medium" sx={{ width: '100%', tableLayout: 'fixed' }}>
            <UserTableHead order={order} orderBy={orderBy} onRequestSort={handleRequestSort} />
            <TableBody>
              {props.loading ? (
                <TableRow>
                  <TableCell rowSpan={3} colSpan={COLUMN_COUNT}>
                    <Box display="flex" justifyContent="center" alignContent="center" py={4}>
                      <CircularProgress />
                    </Box>
                  </TableCell>
                </TableRow>
              ) : filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={COLUMN_COUNT} align="center">
                    <Typography color="text.secondary" py={4}>
                      {searchQuery ? `No users found matching "${searchQuery}"` : 'No users found'}
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                paginatedUsers.map((user) => {
                  const displayName = getDisplayName(user);
                  const username = getUsername(user);
                  const providerLabel = formatProviderLabel(getPrimaryProviderId(user));

                  return (
                    <TableRow hover tabIndex={-1} key={user.uid}>
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
                      <TableCell align="center">
                        <Typography sx={{ fontWeight: 600 }}>{displayName}</Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                          UID: {user.uid}
                        </Typography>
                      </TableCell>
                      <TableCell align="center" sx={{ overflowWrap: 'anywhere' }}>
                        {username}
                      </TableCell>
                      <TableCell align="center" sx={{ overflowWrap: 'anywhere' }}>
                        {user.email ?? '--'}
                      </TableCell>
                      <TableCell align="center">{providerLabel}</TableCell>
                      <TableCell align="center">{formatMetadataDate(user.metadata?.creationTime)}</TableCell>
                      <TableCell align="center">{formatMetadataDate(user.metadata?.lastSignInTime)}</TableCell>
                      <TableCell align="center">
                        {currentUser?.uid === user.uid ? (
                          <Typography>{user.role ?? 'unassigned'}</Typography>
                        ) : (
                          <FormControl disabled={user.loading} size="small" sx={{ minWidth: 140 }}>
                            <Select
                              value={user.role ?? ''}
                              displayEmpty
                              onChange={async (event) => {
                                const role = event.target.value;
                                if (typeof role === 'string' && role.length > 0) {
                                  await props.handleRoleChange(user.uid, role);
                                }
                              }}
                            >
                              <MenuItem value="" disabled>
                                unassigned
                              </MenuItem>
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
                    </TableRow>
                  );
                })
              )}
              {emptyRows > 0 && (
                <TableRow style={{ height: 53 * emptyRows }}>
                  <TableCell colSpan={COLUMN_COUNT} />
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
  prevProps: {
    usersWithLoading: UserWithLoading[];
    loading: boolean;
    toolbarActions?: ReactNode;
    handleRoleChange: (uid: string, role: string) => Promise<void>;
  },
  nextProps: {
    usersWithLoading: UserWithLoading[];
    loading: boolean;
    toolbarActions?: ReactNode;
    handleRoleChange: (uid: string, role: string) => Promise<void>;
  }
) {
  return (
    prevProps.loading === nextProps.loading &&
    prevProps.usersWithLoading === nextProps.usersWithLoading
  );
}

export default memo(UserTable, userTablesAreEqual);
