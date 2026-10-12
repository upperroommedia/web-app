/**
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { defineString, defineInt, defineBoolean, defineSecret } from "firebase-functions/params";
import { AuthenticatonType, Config } from "./types";

const location = defineString("LOCATION", {default: process.env.FUNCTION_DEFAULT_REGION || "us-central1"});
const database = defineString("DATABASE", {default: "(default)"});
const databaseRegion = defineString("DATABASE_REGION", {default: "us-central1"});
const mailCollection = defineString("MAIL_COLLECTION", {default: "mail"});
const smtpConnectionUri = defineString("SMTP_CONNECTION_URI", {default: ""});
const defaultFrom = defineString("DEFAULT_FROM", {default: ""});
const defaultReplyTo = defineString("DEFAULT_REPLY_TO", {default: ""});
const usersCollection = defineString("USERS_COLLECTION", {default: ""});
const templatesCollection = defineString("TEMPLATES_COLLECTION", {default: ""});
const TTLExpireType = defineString("TTL_EXPIRE_TYPE", {default: "never"});
const tls = defineString("TLS_OPTIONS", {default: "{}"});
const host = defineString("HOST", {default: ""});
const user = defineString("USER", {default: ""});
const clientId = defineString("CLIENT_ID", {default: ""});
const authenticationType = defineString("AUTH_TYPE", {default: "UsernamePassword"});
const expireValue = defineInt("TTL_EXPIRE_VALUE", {default: 1});
const oauthPort = defineInt("OAUTH_PORT", {default: 465});
const oauthSecure = defineBoolean("OAUTH_SECURE", {default: true});
export const smtpPassword = defineSecret("SMTP_PASSWORD");
// OAuth credentials are needed only when OAuth is configured. Empty optional secrets
// must not make existing username/password installations require new credentials.
export const oauthSecrets = process.env.AUTH_TYPE?.trim() === "OAuth2" ? [defineSecret("CLIENT_SECRET"), defineSecret("REFRESH_TOKEN")] : [];
export const triggerConfig = {mailCollection, database, location};

const config: Config = {
  get location() {return location.value();},
  get database() {return database.value().trim() || "(default)";},
  get databaseRegion() {return databaseRegion.value();},
  get mailCollection() {return mailCollection.value();},
  get smtpConnectionUri() {return smtpConnectionUri.value().trim();},
  get defaultFrom() {return defaultFrom.value();},
  get defaultReplyTo() {return defaultReplyTo.value().trim();},
  get usersCollection() {return usersCollection.value().trim();},
  get templatesCollection() {return templatesCollection.value().trim();},
  get TTLExpireType() {return TTLExpireType.value().trim() || "never";},
  get tls() {return tls.value();},
  get host() {return host.value().trim();},
  get user() {return user.value().trim();},
  get clientId() {return clientId.value().trim();},
  get authenticationType() {return (authenticationType.value().trim() || "UsernamePassword") as AuthenticatonType;},
  get smtpPassword() {return smtpPassword.value();},
  get clientSecret() {return process.env.CLIENT_SECRET;},
  get refreshToken() {return process.env.REFRESH_TOKEN;},
  get TTLExpireValue() {return expireValue.value();},
  get port() {return oauthPort.value();},
  get secure() {return oauthSecure.value();},
  get testing() {return process.env.TESTING === "true";},
};
export default config;
