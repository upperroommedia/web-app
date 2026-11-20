import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import React, { memo } from 'react';

interface UploaderDatePickerProps {
  date: Date;
  handleDateChange: (newValue: Date) => void;
}

function UploaderDatePicker({ date, handleDateChange }: UploaderDatePickerProps) {
  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <DatePicker
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
