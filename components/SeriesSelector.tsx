import TextField from '@mui/material/TextField';
import ListItem from '@mui/material/ListItem';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import { sanitize } from 'dompurify';
import { FunctionComponent, Dispatch, SetStateAction, useState, useEffect } from 'react';
import { seriesConverter, SeriesSummary, SeriesWithHighlight } from '../types/Series';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import { Sermon } from '../types/SermonTypes';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import NewSeriesPopup from './NewSeriesPopup';
import firestore, { query, collection, getDocs } from '../firebase/firestore';
import AddIcon from '@mui/icons-material/Add';

interface SeriesSelectorProps {
  sermon: Sermon;
  setSermon?: Dispatch<SetStateAction<Sermon>>;
  updateSermon?: <T extends keyof Sermon>(key: T, value: Sermon[T]) => void;
}

const SeriesSelector: FunctionComponent<SeriesSelectorProps> = ({
  sermon,
  setSermon,
  updateSermon,
}: SeriesSelectorProps) => {
  const [newSeriesPopup, setNewSeriesPopup] = useState<boolean>(false);
  const [seriesArray, setSeriesArray] = useState<SeriesWithHighlight[]>([]);
  const [seriesSermon, setSeriesSermon] = useState<Sermon>(sermon);

  const updateSermonSeries = (series: SeriesWithHighlight[] | SeriesSummary[]) => {
    const seriesSummaries: SeriesSummary[] = series.map((series) => {
      if ('_highlightResult' in series || 'sermons' in series) {
        const { _highlightResult, sermons: _, ...seriesSummary } = series;
        return seriesSummary as SeriesSummary;
      }
      console.log('series', series);
      return series;
    });

    setSeriesSermon((previousSermon) => {
      return {
        ...previousSermon,
        series: seriesSummaries,
      };
    });

    if (updateSermon) {
      updateSermon('series', seriesSummaries);
    }
  };

  useEffect(() => {
    setSeriesSermon(sermon);
  }, [sermon]);

  useEffect(() => {
    const fetchSeries = async () => {
      const seriesQuery = query(collection(firestore, 'series')).withConverter(seriesConverter);
      const seriesQuerySnapshot = await getDocs(seriesQuery);
      setSeriesArray(
        seriesQuerySnapshot.docs.map((doc) => {
          const series = doc.data();
          return series;
        })
      );
    };
    fetchSeries();
  }, []);
  return (
    <>
      <Box display="flex" gap={1} width={1} alignItems="center">
        <Autocomplete
          multiple
          fullWidth
          value={seriesSermon.series.map((series) => ({ sermons: [], ...series }))}
          onChange={async (_, newValue) => {
            updateSermonSeries(newValue);
          }}
          id="series-input"
          options={seriesArray}
          renderTags={(series, _) => {
            return series.map((series) => (
              <Chip
                key={series.id}
                label={series.name}
                onDelete={() => {
                  updateSermonSeries(seriesSermon.series.filter((s) => s.id !== series.id));
                }}
                avatar={
                  <AvatarWithDefaultImage
                    defaultImageURL="/user.png"
                    altName={series.name}
                    width={24}
                    height={24}
                    borderRadius={12}
                    image={series.images?.find((image) => image.type === 'square')}
                  />
                }
              />
            ));
          }}
          renderOption={(props, option: SeriesWithHighlight) => (
            <ListItem key={option.id} {...props}>
              <AvatarWithDefaultImage
                defaultImageURL="/user.png"
                altName={option.name}
                width={30}
                height={30}
                image={option.images?.find((image) => image.type === 'square')}
                borderRadius={5}
                sx={{ marginRight: '15px' }}
              />
              {option._highlightResult && seriesArray.find((s) => s.id === option?.id) === undefined ? (
                <div dangerouslySetInnerHTML={{ __html: sanitize(option._highlightResult.name.value) }}></div>
              ) : (
                <div>{option.name}</div>
              )}
            </ListItem>
          )}
          getOptionLabel={(option: SeriesWithHighlight) => option.name}
          isOptionEqualToValue={(option, value) =>
            value.name === undefined ||
            option.name === undefined ||
            (option.name === value.name && option.id === value.id)
          }
          renderInput={(params) => <TextField {...params} label="Series" />}
        />
        <IconButton
          size="small"
          sx={{ height: 'min-content' }}
          onClick={() => {
            setNewSeriesPopup(true);
          }}
        >
          <AddIcon />
        </IconButton>
      </Box>
      <NewSeriesPopup
        newSeriesPopup={newSeriesPopup}
        setNewSeriesPopup={setNewSeriesPopup}
        seriesArray={seriesArray}
        setSeriesArray={setSeriesArray}
        sermon={sermon}
        setSermon={setSermon || setSeriesSermon}
      />
    </>
  );
};

export default SeriesSelector;
