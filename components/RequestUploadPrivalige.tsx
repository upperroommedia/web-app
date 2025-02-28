import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import { useState } from 'react';
import { UserRole, UserRoleType } from '../types/User';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import Stack from '@mui/system/Stack';

const RequestRoleChange = () => {
  const defaultValue = UserRole.UPLOADER;
  const [role, setRole] = useState<UserRoleType>(defaultValue);
  const [reason, setReason] = useState('');
  return (
    <FormControl sx={{ display: 'flex', gap: 2, width: 1, maxWidth: 600 }}>
      <InputLabel id="role-select-label">Role</InputLabel>
      <Select
        defaultValue={defaultValue}
        labelId="role-select-label"
        id="role-select"
        value={role}
        label="Age"
        onChange={(event) => setRole(event.target.value as UserRoleType)}
      >
        {Object.values(UserRole)
          .filter((role) => role !== 'user')
          .map((role) => (
            <MenuItem key={role} value={role}>
              {role}
            </MenuItem>
          ))}
      </Select>
      <TextField
        sx={{
          display: 'block',
        }}
        fullWidth
        rows={4}
        id="reason-text"
        label="Reason"
        name="reason"
        placeholder="Please enter your reason for the specific role change."
        multiline
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <Tooltip title="This feature is not yet implemented. Please contact the admin directly.">
        <Stack>
          <Button
            type="submit"
            disabled={true}
            onClick={() => {
              alert('This feature is not yet implemented. Please contact the admin directly.');
            }}
          >
            Submit
          </Button>
        </Stack>
      </Tooltip>
    </FormControl>
    // TODO: Make form functional
  );
};

export default RequestRoleChange;
