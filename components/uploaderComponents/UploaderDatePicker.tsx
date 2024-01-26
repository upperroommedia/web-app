import TextField from '@mui/material/TextField';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { DesktopDatePicker } from '@mui/x-date-pickers/DesktopDatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import React, { memo } from 'react';

interface UploaderDatePickerProps {
  date: Date;
  handleDateChange: (newValue: Date) => void;
}

function UploaderDatePicker({ date, handleDateChange }: UploaderDatePickerProps) {
  return (
    <LocalizationProvider dateAdapter={AdapterDateFns} sx={{ width: 1 }} fullWidth>
      <DesktopDatePicker
        label="Date"
        inputFormat="MM/dd/yyyy"
        value={date}
        onChange={(newValue) => {
          if (newValue !== null) {
            handleDateChange(new Date(newValue));
          }
        }}
        renderInput={(params) => <TextField {...params} />}
      />
    </LocalizationProvider>
  );
}

export default memo(UploaderDatePicker);
