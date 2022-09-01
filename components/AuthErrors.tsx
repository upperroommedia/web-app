const createErrorObject = (
  title: string,
  errorMessage: string,
  authFailure: boolean,
  dest: string
) => {
  return {
    title: title,
    errorMessage: errorMessage,
    authFailure: authFailure,
    dest: dest,
  };
};

const AuthErrors = (error: string) => {
  switch (error) {
    case 'auth/user-not-found':
      return createErrorObject(
        'Wrong Credentials',
        'Double Check your username and password',
        true,
        ''
      );
    case 'auth/weak-password':
      return createErrorObject(
        'Weak Password',
        'Make a password with 6 or more characters',
        true,
        ''
      );
    case 'auth/email-already-in-use':
      return createErrorObject(
        'Email Already in Use',
        'The email you are using is Already in Use',
        true,
        ''
      );
    case 'auth/uid-already-exists':
      return createErrorObject(
        'Username already Exists',
        'The provided username is already in use by an existing user. Try again using another username.',
        true,
        ''
      );
    default:
      return createErrorObject('', '', false, '/uploader');
  }
};

export default AuthErrors;
