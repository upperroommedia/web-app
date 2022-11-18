import dynamic from 'next/dynamic';
import { ChangeEvent, useEffect, useState, Dispatch, SetStateAction } from 'react';
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
import { ISpeaker } from '../types/Speaker';
import { visuallyHidden } from '@mui/utils';
// import FormGroup from '@mui/material/FormGroup';
// import FormControlLabel from '@mui/material/FormControlLabel';
// import Checkbox from '@mui/material/Checkbox';
// import Button from '@mui/material/Button';
// import Menu from '@mui/material/Menu';
import { Order } from '../pages/admin';

interface HeadCell {
  disablePadding: boolean;
  id: keyof ISpeaker;
  label: string;
  numeric: boolean;
}

const headCells: readonly HeadCell[] = [
  {
    id: 'name',
    numeric: false,
    disablePadding: false,
    label: 'Name',
  },
  {
    id: 'sermonCount',
    numeric: true,
    disablePadding: false,
    label: 'Sermon Count',
  },
  {
    id: 'listId',
    numeric: false,
    disablePadding: false,
    label: 'List Id',
  },
  {
    id: 'images',
    numeric: false,
    disablePadding: false,
    label: 'Images',
  },
];

interface SpeakerTableProps {
  onRequestSort: (event: any, property: keyof ISpeaker) => void;
  order: Order;
  orderBy: string;
  rowCount: number;
}

const SpeakerTableHead = (props: SpeakerTableProps) => {
  const { order, orderBy, onRequestSort } = props;
  const createSortHandler = (property: keyof ISpeaker) => (event: any) => {
    onRequestSort(event, property);
  };

  return (
    <TableHead>
      <TableRow>
        {headCells.map((headCell) =>
          headCell.id === 'name' || headCell.id === 'sermonCount' ? (
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
            <TableCell key={headCell.id}>{headCell.label}</TableCell>
          )
        )}
      </TableRow>
    </TableHead>
  );
};

export interface Filters {
  none: boolean;
  hasListId: boolean;
  hasSquareImage: boolean;
  hasWideImage: boolean;
  hasBannerImage: boolean;
}

// enum FilterLabels {
//   none = 'No Filter',
//   hasListId = 'Contains List Id',
//   hasSquareImage = 'Contains Square Image',
//   hasWideImage = 'Contains Wide Image',
//   hasBannerImage = 'Contains Banner Image',
// }

const SpeakerTableToolbar = () =>
  // filters: Filters;
  // setFilters: Dispatch<SetStateAction<Filters>>;
  // handleRequestFilter: (filter: string) => void;
  {
    // const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
    // const open = Boolean(anchorEl);
    // const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    //   setAnchorEl(event.currentTarget);
    // };
    // const handleClose = () => {
    //   setAnchorEl(null);
    // };
    return (
      <Toolbar
        sx={{
          pl: { sm: 2 },
          pr: { xs: 1, sm: 1 },
        }}
      >
        <Typography sx={{ flex: '1 1 100%' }} variant="h6" id="tableTitle" component="div">
          Speakers
        </Typography>
        {/* <Button
        id="basic-button"
        aria-controls={open ? 'basic-menu' : undefined}
        aria-haspopup="true"
        aria-expanded={open ? 'true' : undefined}
        onClick={handleClick}
      >
        Filters
      </Button>
      <Menu
        id="basic-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        MenuListProps={{
          'aria-labelledby': 'basic-button',
        }}
      >
        <FormGroup sx={{ pl: '1em' }}>
          {Object.keys(props.filters).map((filter) => {
            return (
              <FormControlLabel
                key={filter}
                control={<Checkbox checked={props.filters[filter as keyof Filters]} />}
                label={FilterLabels[filter as keyof Filters]}
                onClick={() => {
                  props.setFilters((oldFilters) => ({ ...oldFilters, [filter]: !oldFilters[filter as keyof Filters] }));
                  if (filter === 'none' && props.filters.none === false) {
                    props.setFilters({
                      none: true,
                      hasListId: false,
                      hasSquareImage: false,
                      hasWideImage: false,
                      hasBannerImage: false,
                    });
                  }
                }}
                disabled={filter !== 'none' && props.filters.none}
              />
            );
          })}
        </FormGroup>
      </Menu> */}
      </Toolbar>
    );
  };

const DynamicPopUp = dynamic(() => import('./PopUp'), { ssr: false });

const SpeakerTable = (props: {
  speakers: ISpeaker[];
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  rowsPerPage: number;
  totalSpeakers: number;
  setTotalSpeakers: Dispatch<SetStateAction<number>>;
  handlePageChange: (newPage: number) => void;
  handleChangeRowsPerPage: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleSort: (property: keyof ISpeaker, order: Order) => Promise<void>;
  sortOrder: Order;
  setSortOrder: Dispatch<SetStateAction<Order>>;
  sortProperty: keyof ISpeaker;
  setSortProperty: Dispatch<SetStateAction<keyof ISpeaker>>;
}) => {
  const [filteredSpeakers, setFilteredSpeakers] = useState<ISpeaker[]>(props.speakers);
  // const [initialTotalSpeakers] = useState<number>(props.totalSpeakers);

  const [selectedSpeaker, setSelectedSpeaker] = useState<ISpeaker>();
  const [speakerDetailsPopup, setSpeakerDetailsPopup] = useState<boolean>(false);

  // const [filters, setFilters] = useState<Filters>({
  //   none: true,
  //   hasListId: false,
  //   hasSquareImage: false,
  //   hasWideImage: false,
  //   hasBannerImage: false,
  // });

  const handleRequestSort = async (_: any, property: keyof ISpeaker) => {
    const isAsc = props.sortOrder === 'asc';
    props.setSortOrder(isAsc ? 'desc' : 'asc');
    props.setSortProperty(property);
    const sortOrder = props.sortOrder === 'asc' ? 'desc' : 'asc';
    await props.handleSort(property, sortOrder);
  };

  // const handleRequestFilter = () => {
  //   let filtered = props.speakers;
  //   props.setPage(0);
  //   if (filters.none) {
  //     setFilteredSpeakers(props.speakers);
  //     props.setTotalSpeakers(initialTotalSpeakers);
  //     return;
  //   }
  //   if (filters.hasListId) {
  //     filtered = filtered.filter((speaker) => speaker.listId !== undefined);
  //   } else {
  //     filtered = filtered.filter((speaker) => speaker.listId === undefined);
  //   }
  //   if (filters.hasSquareImage) {
  //     filtered = filtered.filter((speaker) => speaker.images.find((image) => image.type === 'square') !== undefined);
  //   } else {
  //     filtered = filtered.filter((speaker) => speaker.images.find((image) => image.type === 'square') === undefined);
  //   }
  //   if (filters.hasWideImage) {
  //     filtered = filtered.filter((speaker) => speaker.images.find((image) => image.type === 'wide') !== undefined);
  //   } else {
  //     filtered = filtered.filter((speaker) => speaker.images.find((image) => image.type === 'wide') === undefined);
  //   }
  //   if (filters.hasBannerImage) {
  //     filtered = filtered.filter((speaker) => speaker.images.find((image) => image.type === 'banner') !== undefined);
  //   } else {
  //     filtered = filtered.filter((speaker) => speaker.images.find((image) => image.type === 'banner') === undefined);
  //   }
  //   props.setTotalSpeakers(filtered.length);
  //   setFilteredSpeakers(filtered);
  // };

  const handleClick = (speaker: ISpeaker) => {
    setSelectedSpeaker(speaker);
    setSpeakerDetailsPopup(true);
  };

  useEffect(() => {
    setFilteredSpeakers(props.speakers);
  }, [props.speakers]);

  // useEffect(() => {
  //   handleRequestFilter();
  // }, [filters]);

  return (
    <>
      <Box sx={{ width: '100%' }}>
        <Paper sx={{ width: '100%', mb: 2 }}>
          <SpeakerTableToolbar />
          <TableContainer>
            <Table sx={{ minWidth: 750 }} aria-labelledby="tableTitle" size={'medium'}>
              <SpeakerTableHead
                order={props.sortOrder}
                orderBy={props.sortProperty}
                onRequestSort={handleRequestSort}
                rowCount={filteredSpeakers.length}
              />
              <TableBody>
                {props.speakers
                  .slice(props.page * props.rowsPerPage, props.page * props.rowsPerPage + props.rowsPerPage)
                  .map((speaker) => {
                    return (
                      <TableRow hover onClick={() => handleClick(speaker)} tabIndex={-1} key={speaker.id}>
                        <TableCell component="th" id={speaker.name} scope="row" padding="none">
                          {speaker.name}
                        </TableCell>
                        <TableCell>{speaker.sermonCount}</TableCell>
                        <TableCell>{speaker.listId ? speaker.listId : 'No list'}</TableCell>
                        <TableCell align="right" style={{ display: 'flex', gap: '10px', justifyContent: 'start' }}>
                          {['banner', 'wide', 'square'].map((type, i) => {
                            const image = speaker.images?.find((image) => image.type === type);
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
                                {image && <Image src={image.downloadLink} layout="fill" objectFit="contain" />}
                              </div>
                            );
                          })}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            rowsPerPageOptions={[5, 10, 25]}
            component="div"
            count={props.totalSpeakers}
            rowsPerPage={props.rowsPerPage}
            page={props.page}
            onPageChange={(_, newPage) => props.handlePageChange(newPage)}
            onRowsPerPageChange={props.handleChangeRowsPerPage}
          />
        </Paper>
      </Box>
      <DynamicPopUp
        title="Speaker Details"
        open={speakerDetailsPopup}
        setOpen={setSpeakerDetailsPopup}
        dialogProps={{ fullWidth: true, maxWidth: 'lg' }}
      >
        <div style={{ textAlign: 'center' }}>
          <h2>{selectedSpeaker?.name}</h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px,100%), 1fr))',
              alignItems: 'center',
              justifyItems: 'center',
              gap: '10px',
            }}
          >
            {['square', 'wide', 'banner'].map((type, i) => {
              const image = selectedSpeaker?.images?.find((image) => image.type === type);
              if (!image)
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      borderRadius: '2px',
                      overflow: 'hidden',
                      position: 'relative',
                      width: 300,
                      height: 300,
                      justifyContent: 'center',
                      alignItems: 'center',
                      backgroundColor: '#f3f1f1',
                    }}
                  >
                    <span>Add image +</span>
                  </div>
                );
              return (
                <div
                  key={image.id}
                  style={{
                    borderRadius: '2px',
                    overflow: 'hidden',
                    position: 'relative',
                    width: 300,
                    height: 300,
                    // aspectRatio: image.width / image.height,
                    // backgroundImage: `url(${'/user.png'})`,
                    // backgroundPosition: 'center center',
                    // backgroundSize: 'cover',
                    backgroundColor: image.averageColorHex || '#f3f1f1',
                  }}
                >
                  <Image src={image.downloadLink} layout="fill" objectFit="contain" />
                </div>
              );
            })}
          </div>
        </div>
      </DynamicPopUp>
    </>
  );
};

export default SpeakerTable;
