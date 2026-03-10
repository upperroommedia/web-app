import dynamic from 'next/dynamic';
import { ChangeEvent, useState, Dispatch, SetStateAction, useCallback, MouseEvent } from 'react';
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
import CircularProgress from '@mui/material/CircularProgress';
import Button from '@mui/material/Button';
import AddIcon from '@mui/icons-material/Add';
import { ISpeaker, speakerConverter } from '../types/Speaker';
import { visuallyHidden } from '@mui/utils';
// import FormGroup from '@mui/material/FormGroup';
// import FormControlLabel from '@mui/material/FormControlLabel';
// import Checkbox from '@mui/material/Checkbox';
// import Button from '@mui/material/Button';
// import Menu from '@mui/material/Menu';


import ImageViewer from './ImageViewer';
import firestore, { doc, updateDoc } from '../firebase/firestore';
import { ImageSizeType, ImageType, isImageType } from '../types/Image';
import { Order } from '../context/types';

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
  onRequestSort: (event: MouseEvent<HTMLElement>, property: keyof ISpeaker) => void;
  order: Order;
  orderBy: string;
  rowCount: number;
}

const SpeakerTableHead = (props: SpeakerTableProps) => {
  const { order, orderBy, onRequestSort } = props;
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

interface SpeakerTableToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  onAddSpeaker: () => void;
}

const SpeakerTableToolbar = ({ searchValue, onSearchChange, onAddSpeaker }: SpeakerTableToolbarProps) => {
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

const DynamicPopUp = dynamic(() => import('./PopUp'), { ssr: false });

const SpeakerTable = (props: {
  speakers: ISpeaker[];
  setSpeakers: Dispatch<SetStateAction<ISpeaker[]>>;
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
  searchValue: string;
  onSearchChange: (value: string) => void;
  onAddSpeaker: () => void;
  loading?: boolean;
}) => {
  const [selectedSpeaker, setSelectedSpeaker] = useState<ISpeaker>();

  const [speakerDetailsPopup, setSpeakerDetailsPopup] = useState<boolean>(false);

  // const [filters, setFilters] = useState<Filters>({
  //   none: true,
  //   hasListId: false,
  //   hasSquareImage: false,
  //   hasWideImage: false,
  //   hasBannerImage: false,
  // });

  const removeImage = useCallback(
    async (imageType: ImageSizeType) => {
      if (!selectedSpeaker) {
        return;
      }
      try {
        await updateDoc(doc(firestore, 'speakers', selectedSpeaker.id).withConverter(speakerConverter), {
          images: selectedSpeaker.images.filter((image) => image.type !== imageType),
        });
        props.setSpeakers((oldSpeakers) =>
          oldSpeakers.map((speaker) => {
            if (speaker.id === selectedSpeaker.id) {
              return {
                ...speaker,
                images: speaker.images.filter((image) => image.type !== imageType),
              };
            }
            return speaker;
          })
        );
        setSelectedSpeaker((oldSpeaker) => {
          if (oldSpeaker) {
            return {
              ...oldSpeaker,
              images: oldSpeaker.images.filter((image) => image.type !== imageType),
            };
          }
          return oldSpeaker;
        });
      } catch (error) {
        alert(error);
      }
    },
    [props, selectedSpeaker]
  );

  const setSpeakerImage = useCallback(
    async (newImage: ImageType) => {
      if (!selectedSpeaker) {
        return;
      }
      try {
        await updateDoc(doc(firestore, 'speakers', selectedSpeaker.id).withConverter(speakerConverter), {
          images:
            Array.isArray(selectedSpeaker.images) &&
            selectedSpeaker.images.find((image) => image.type === newImage.type)
              ? selectedSpeaker.images.map((image) => {
                  if (image.type === newImage.type) {
                    return newImage;
                  }
                  return image;
                })
              : [...(selectedSpeaker.images || []), newImage],
        });
        props.setSpeakers((oldSpeakers) =>
          oldSpeakers.map((speaker) => {
            if (speaker.id === selectedSpeaker.id) {
              const newSpeaker = {
                ...speaker,
                images: speaker.images.find((image) => image.type === newImage.type)
                  ? speaker.images.map((image) => {
                      if (image.type === newImage.type) {
                        return newImage;
                      }
                      return image;
                    })
                  : [...speaker.images, newImage],
              };
              setSelectedSpeaker(newSpeaker);
              return newSpeaker;
            }
            return speaker;
          })
        );
      } catch (e) {
        alert(e);
      }
    },
    [props, selectedSpeaker]
  );

  const handleImageUpdate = useCallback(
    async (newImage: ImageType | ImageSizeType) => {
      if (isImageType(newImage)) {
        await setSpeakerImage(newImage as ImageType);
      } else {
        await removeImage(newImage as ImageSizeType);
      }
    },
    [removeImage, setSpeakerImage]
  );

  const handleRequestSort = async (_: MouseEvent<HTMLElement>, property: keyof ISpeaker) => {
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

  // useEffect(() => {
  //   handleRequestFilter();
  // }, [filters]);

  return (
    <>
      <Box width={1} display="flex" justifyContent="center">
        <Card sx={{ width: 1 }}>
          <SpeakerTableToolbar
            searchValue={props.searchValue}
            onSearchChange={props.onSearchChange}
            onAddSpeaker={props.onAddSpeaker}
          />
          <TableContainer>
            <Table sx={{ minWidth: 750 }} aria-labelledby="tableTitle" size={'medium'}>
              <SpeakerTableHead
                order={props.sortOrder}
                orderBy={props.sortProperty}
                onRequestSort={handleRequestSort}
                rowCount={props.speakers.length}
              />
              <TableBody>
                {props.loading ? (
                  <TableRow>
                    <TableCell colSpan={4} align="center">
                      <Box display="flex" justifyContent="center" py={4}>
                        <CircularProgress />
                      </Box>
                    </TableCell>
                  </TableRow>
                ) : props.speakers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} align="center">
                      <Typography color="text.secondary" py={4}>
                        {props.searchValue ? `No speakers found matching "${props.searchValue}"` : 'No speakers found'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  props.speakers
                    .slice(props.page * props.rowsPerPage, props.page * props.rowsPerPage + props.rowsPerPage)
                    .map((speaker) => {
                      return (
                        <TableRow hover onClick={() => handleClick(speaker)} tabIndex={-1} key={speaker.id} sx={{ cursor: 'pointer' }}>
                          <TableCell align="center" component="th" id={speaker.name} scope="row" padding="none">
                            {speaker.name}
                          </TableCell>
                          <TableCell align="center">{speaker.sermonCount || 0}</TableCell>
                          <TableCell align="center">{speaker.listId || 'No list'}</TableCell>
                          <TableCell>
                            <Box
                              display="flex"
                              justifyContent="center"
                              gap={1}
                            >
                              {['square', 'wide', 'banner'].map((type, i) => {
                                const image = speaker.images?.find((image) => image.type === type);
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
                      );
                    })
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            rowsPerPageOptions={[25, 50, 100]}
            component="div"
            count={props.totalSpeakers}
            rowsPerPage={props.rowsPerPage}
            page={props.page}
            onPageChange={(_, newPage) => props.handlePageChange(newPage)}
            onRowsPerPageChange={props.handleChangeRowsPerPage}
          />
        </Card>
      </Box>
      <DynamicPopUp
        title="Speaker Details"
        open={speakerDetailsPopup}
        setOpen={setSpeakerDetailsPopup}
        dialogProps={{ fullWidth: true, maxWidth: 'lg' }}
      >
        <div style={{ textAlign: 'center' }}>
          <h2>{selectedSpeaker?.name}</h2>
          {selectedSpeaker && (
            <ImageViewer
              images={selectedSpeaker.images}
              speaker={selectedSpeaker}
              newImageCallback={handleImageUpdate}
            />
          )}
        </div>
        {/* </div> */}
      </DynamicPopUp>
    </>
  );
};

export default SpeakerTable;
