// Import the functions you need from the SDKs you need
import { initializeApp } from 'firebase/app';
// import { getAnalytics } from 'firebase/analytics';
import { getAuth } from 'firebase/auth';
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: 'AIzaSyCJKArKBX02ItsUD1zDJVC6JRA4sho7PTo',
  authDomain: 'urm-app.firebaseapp.com',
  databaseURL: 'https://urm-app-default-rtdb.firebaseio.com',
  projectId: 'urm-app',
  storageBucket: 'urm-app.appspot.com',
  messagingSenderId: '747878690617',
  appId: '1:747878690617:web:d29679a2961a60f31b82e8',
  measurementId: 'G-3PE6CE9N0H',
};

// Initialize Firebase
// eslint-disable-next-line no-unused-vars
const app = initializeApp(firebaseConfig);
// const analytics = getAnalytics(app);
export const auth = getAuth();
