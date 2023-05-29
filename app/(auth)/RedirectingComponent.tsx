import CircularProgress from '@mui/material/CircularProgress';

type Params = {
  path: string;
};
export default function RedirectingComponent({ path }: Params) {
  return (
    <div>
      <p>
        Redirecting to <strong>{path}</strong> <CircularProgress />
      </p>
    </div>
  );
}
