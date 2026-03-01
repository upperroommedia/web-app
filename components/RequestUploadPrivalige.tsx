import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import { FormEvent, useState } from 'react';
import { UserRole, UserRoleType } from '../types/User';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Alert, { AlertColor } from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import { createFunctionV2 } from '../utils/createFunction';
import { CreateRoleRequestInputType, CreateRoleRequestOutputType } from '../functions/src/roleRequests/roleRequestTypes';

const RequestRoleChange = () => {
  const defaultValue = UserRole.UPLOADER;
  const [role, setRole] = useState<UserRoleType>(defaultValue);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ severity: AlertColor; message: string } | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setFeedback(null);

    try {
      const createRoleRequest = createFunctionV2<CreateRoleRequestInputType, CreateRoleRequestOutputType>('createrolerequest');
      const response = await createRoleRequest({
        requestedRole: role,
        reason,
      });

      if (response.status === 'error') {
        throw new Error(response.error);
      }

      const warningText = response.data.warning ? ` ${response.data.warning.message}` : '';
      const message =
        response.data.requestStatus === 'existing'
          ? `A pending request for ${role} already exists.${warningText}`
          : `Your request for ${role} has been submitted.${warningText}`;

      setFeedback({
        severity: response.data.warning ? 'warning' : 'success',
        message,
      });
      if (response.data.requestStatus === 'created') {
        setReason('');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to submit role request.';
      setFeedback({ severity: 'error', message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormControl component="form" onSubmit={handleSubmit} sx={{ display: 'flex', gap: 2, width: 1, maxWidth: 600 }}>
      <InputLabel id="role-select-label">Role</InputLabel>
      <Select
        defaultValue={defaultValue}
        labelId="role-select-label"
        id="role-select"
        value={role}
        label="Role"
        disabled={submitting}
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
        fullWidth
        rows={4}
        id="reason-text"
        label="Reason"
        name="reason"
        placeholder="Please enter your reason for the specific role change."
        multiline
        value={reason}
        disabled={submitting}
        onChange={(event) => setReason(event.target.value)}
      />
      <Button type="submit" variant="contained" disabled={submitting || reason.trim().length === 0}>
        {submitting ? <CircularProgress size={20} color="inherit" /> : 'Submit Request'}
      </Button>
      {feedback && <Alert severity={feedback.severity}>{feedback.message}</Alert>}
    </FormControl>
  );
};

export default RequestRoleChange;
