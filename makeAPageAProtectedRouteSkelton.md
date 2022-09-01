
1. Import ProtectedRoute function from the components folder

EX: import ProtectedRoute from '../components/ProtectedRoute';


2. Put the following code in the getServerSideProps
```
  const userCredentials = await ProtectedRoute(ctx);
  if (userCredentials.props.token) {
      // Fetch all the props from in here
  } else {
    const failedUserCredentials = userCredentials;
    return failedUserCredentials;
  }
```