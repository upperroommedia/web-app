const createErrorObject = (title: string, errorMessage: string, authFailure: boolean, dest: string) => {
  return {
    title: title,
    errorMessage: errorMessage,
    authFailure: authFailure,
    dest: dest,
  };
};

const AuthErrors = (error: string) => {
  switch (error) {
    case 'auth/weak-password':
      return createErrorObject('Weak Password', 'Make a password with 6 or more characters', true, '');
    case 'auth/email-already-in-use':
      return createErrorObject('Email Already in Use', 'The email you are using is already in use', true, '');
    case 'auth/uid-already-exists':
      return createErrorObject(
        'Username already Exists',
        'The provided username is already in use by an existing user. Try again using another username.',
        true,
        ''
      );
    case undefined:
      // Login or SignUp Succeeded
      return createErrorObject('', '', false, '/');
    default:
      return createErrorObject('Wrong Credentials', 'Double check your username and password', true, '');
  }
};

export default AuthErrors;
