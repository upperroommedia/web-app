const express = require('express');
const ytdl = require('ytdl-core');
const cors = require('cors');
const {initializeApp, cert} = require('firebase-admin/app');
const {getAuth} = require('firebase-admin/auth');
const privateKey = JSON.parse(process.env.FIREBASE_ADMIN_PRIVATE_KEY);
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
const projectId = process.env.FIREBASE_PROJECT_ID;

const firebaseApp = initializeApp({
  credential: cert({
    projectId,
    privateKey,
    clientEmail,
  }),
});
const app = express();
app.use(
  cors({
    origin: '*',
  })
);

app.get('/', async (req, res) => {
  if (!req.headers.authorization) {
    res.status(401).set('No authorization token was sent');
  }

  if (!req.query.url) {
    res.status(500).send('No url query parameter provided');
  }
  try {
    await getAuth(firebaseApp).verifyIdToken(
      req.headers.authorization.split(' ')[1]
    );
  } catch (_error) {
    res.status(401).set('User is not authenticated');
  }
  try {
    res.contentType('audio/mpeg');
    ytdl(req.query.url, {
      filter: 'audioonly',
      quality: 'highestaudio',
    }).pipe(res);
  } catch (e) {
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `Hello from Cloud Run! The container started successfully and is listening for HTTP requests on ${PORT}`
  );
});
