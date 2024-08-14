import 'jest';
import functions from 'firebase-functions-test';
import * as admin from 'firebase-admin';
import { resolve } from 'path';
import { getFirestoreCoverageMeta } from '../../test/utils';
import axios from 'axios';
import { logger } from 'firebase-functions/v2';

// Mock axios
jest.mock('axios');
export const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock logger
export const mockLogV2 = jest.spyOn(logger, 'info').mockImplementation();

// We start FirebaseFunctionsTest offline
export const testEnv = functions();
export const PROJECT_ID = 'urm-app';
const FIREBASE_JSON = resolve(__dirname, '../../firebase.json');
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { host, port } = getFirestoreCoverageMeta(PROJECT_ID, FIREBASE_JSON);
process.env.FIRESTORE_EMULATOR_HOST = `${host}:${port}`;
admin.initializeApp({ projectId: PROJECT_ID });
export const mockFirestoreDB = admin.firestore();
