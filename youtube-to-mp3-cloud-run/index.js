/* eslint-disable no-console */
const ffmpeg = require('fluent-ffmpeg');
const express = require('express');
const ytdl = require('ytdl-core');
const cors = require('cors');
const winston = require('winston');
const expressWinston = require('express-winston');

const app = express();
app.use(
  cors({
    origin: '*',
  })
);
app.use(
  expressWinston.logger({
    transports: [new winston.transports.Console()],
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.json()
    ),
    meta: true, // optional: control whether you want to log the meta data about the request (default to true)
    msg: 'HTTP {{req.method}} {{req.url}}', // optional: customize the default logging message. E.g. "{{res.statusCode}} {{req.method}} {{res.responseTime}}ms {{req.url}}"
    expressFormat: true, // Use the default Express/morgan request formatting. Enabling this will override any msg if true. Will only output colors with colorize set to true
    colorize: false, // Color the text and status code, using the Express/morgan color palette (text: gray, status: default green, 3XX cyan, 4XX yellow, 5XX red).
    ignoreRoute: function (_req, _res) {
      return false;
    }, // optional: allows to skip some log messages based on request and/or response
  })
);

app.get('/', async (req, res) => {
  if (!req.query.url) {
    res.status(500).send('No url query parameter provided');
  }
  try {
    console.log('URL', req.query.url);
    res.contentType('audio/mpeg');
    const audio = ytdl(req.query.url, {
      filter: 'audioonly',
      quality: 'highestaudio',
    });
    ffmpeg(audio)
      .audioCodec('libmp3lame')
      .audioBitrate(128)
      .format('mp3')
      .on('start', function (commandLine) {
        console.info(
          'Trim And Transcode Spawned Ffmpeg with command: ' + commandLine
        );
      })
      .on('progress', function (progress) {
        console.info('Processing: ', progress);
      })
      .on('error', (err) => {
        console.error('FFMPG ERROR', err);
        res.status(500).send('Internal Server Error', err);
      })
      .on('end', () => console.log('Finished!'))
      .pipe(res, {
        end: true,
      });
  } catch (e) {
    console.error(e);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `Hello from Cloud Run! The youtube-to-mp3 started successfully and is listening for HTTP requests on ${PORT}`
  );
});
