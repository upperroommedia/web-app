import Button from '@mui/material/Button';
import { Dispatch, SetStateAction, useState } from 'react';
import PopUp from './PopUp';
import { TextField } from '@mui/material';

interface ProvideFeedbackPopupProps {
  provideFeedbackPopup: boolean;
  setProvideFeedbackPopup: Dispatch<SetStateAction<boolean>>;
  handleReject: (feedback: string) => Promise<void>;
}

const ProvideFeedbackPopup = (props: ProvideFeedbackPopupProps) => {
  const [feedback, setFeedback] = useState<string>('');
  return (
    <PopUp
      title={'Please provide feedback for why you are rejecting this upload.'}
      open={props.provideFeedbackPopup}
      setOpen={props.setProvideFeedbackPopup}
      button={
        <Button
          onClick={async () => {
            await props.handleReject(feedback);
            props.setProvideFeedbackPopup(false);
          }}
          color="error"
          disabled={feedback === ''}
          variant="contained"
        >
          Reject
        </Button>
      }
    >
      <div>
        <TextField value={feedback} multiline fullWidth onChange={(e) => setFeedback(e.target.value)} />
      </div>
    </PopUp>
  );
};

export default ProvideFeedbackPopup;
