const express = require('express');
const ytdl = require('ytdl-core');
const cors = require('cors');

const app = express();
app.use(
  cors({
    origin: '*',
  })
);

app.get('/', async (req, res) => {
  if (!req.query.url) {
    res.status(500).send('No url query parameter provided');
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
