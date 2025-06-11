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
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <DesktopDatePicker
        label="Date"
        format="MM/dd/yyyy"
        value={date}
        onChange={(newValue) => {
          if (newValue !== null) {
            handleDateChange(new Date(newValue));
          }
        }}
        sx={{ width: 1 }}
      />
    </LocalizationProvider>
  );
}

export default memo(UploaderDatePicker);
