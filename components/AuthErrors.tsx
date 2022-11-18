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
    case 'auth/email-already-exists':
      return createErrorObject('Email Already in Use', 'This email is already in use', true, '');
    case 'auth/invalid-email':
      return createErrorObject('Invalid Email', 'The email provided is not a valid email', true, '');
    case 'auth/invalid-password':
      return createErrorObject('Weak Password', 'Password must have at least 6 characters', true, '');
    case 'auth/user-not-found':
      return createErrorObject('Email not found', 'No account with this email exists', true, '');
    case 'auth/email-already-in-use':
      return createErrorObject('Account already exists', 'The email provided is already in use', true, '');
    case undefined:
      // Login or SignUp Succeeded
      return createErrorObject('', '', false, '/');
    default:
      return createErrorObject('Wrong Credentials', 'Double check your username and password', true, '');
  }
};

export default AuthErrors;
