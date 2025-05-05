import { google } from 'googleapis';

/**
 * Lists the labels in the user's account.
 *
 * @param {number} filter_after_timestamp unix timestamp in seconds on which to filter for messages after
 * @returns the 6 digit verification code
 */
export default async function getVerificationCode(filter_after_timestamp: number, retries_left = 3): Promise<string> {
  if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error('Could not find GOOGLE_CREDENTIALS in .env');
  }
  const credentials = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS, 'base64').toString());
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'], // Specify the desired API scopes
    clientOptions: {
      subject: process.env.EMAIL, // gmail account you want to access
    },
  });
  const gmail = google.gmail({ version: 'v1', auth });

  const attempt = async (remainingRetries: number): Promise<string> => {
    try {
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: `from:no-reply@subsplash.com after:${filter_after_timestamp}`,
        maxResults: 1,
      });
      const messages = res.data.messages;

      if (!messages || messages.length === 0) {
        if (remainingRetries > 0) {
          console.log('No emails found, retrying in 2 seconds...');
          await sleep(2000); // Wait for 2 seconds before retrying
          return attempt(remainingRetries - 1);
        } else {
          console.log('No messages found.');
          throw new Error('No emails found with filter settings');
        }
      }

      const latestMessage = messages[0];
      if (!latestMessage.id) {
        console.log('Error finding message id');
        throw new Error('Error finding message id');
      }

      const latestMessageId = latestMessage.id;
      const message = await gmail.users.messages.get({
        userId: 'me',
        id: latestMessageId,
      });

      // Decode the message body
      const payload = message.data.payload;
      if (!payload) {
        throw new Error('Message payload is empty');
      }

      let body = '';

      // Extract the body from the 'text/plain' or 'text/html' part
      const part =
        payload.parts?.find((part) => part.mimeType === 'text/plain') ||
        payload.parts?.find((part) => part.mimeType === 'text/html');
      if (part?.body?.data) {
        body = Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (payload?.body?.data) {
        body = Buffer.from(payload.body?.data, 'base64').toString('utf-8');
      }

      const codePattern = /\b\d{6}\b/;

      // Find the match
      const match = body.match(codePattern);

      // Return the matched code, or throw if not found
      const verification_code = match ? match[0] : null;
      if (!verification_code) {
        throw new Error('Verification code not found in the email body');
      }

      console.log('Verification Code:', verification_code);
      return verification_code;
    } catch (error) {
      console.error('Error during attempt:', error);
      if (remainingRetries > 0) {
        console.log('Retrying...');
        await sleep(2000); // Wait before retrying
        return attempt(remainingRetries - 1);
      }
      throw error; // Rethrow the error if out of retries
    }
  };

  return attempt(retries_left);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
