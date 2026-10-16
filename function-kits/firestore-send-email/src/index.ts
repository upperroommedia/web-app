import { assertLegacyEmailTransportAllowed, emailCaptureProfile } from './temporal/capture';
import { randomUUID } from 'node:crypto';
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

import { getApps, initializeApp } from "firebase-admin/app";
import {
  FieldValue,
  Timestamp,
  Firestore,
  DocumentSnapshot,
  DocumentReference,
  getFirestore,
} from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as functions from "firebase-functions";
import * as nodemailer from "nodemailer";
import { expr } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { migratedOptions } from "./system-options";
import { assertLegacyEmailRelease, assertNewLegacyEmailClaim } from "./temporal/release";
import { secureMailOptions } from "./temporal/secure-options";
import { enqueueTemporalEmail } from "./temporal/ingress";
import { getEmailExpireAt as getExpireAt, getEmailExpiryPolicy } from "./temporal/expiry";

const systemOptions = migratedOptions();
setGlobalOptions(systemOptions);
const deliveryLeaseMillis = ((Number(systemOptions.timeoutSeconds) || 120) + 60) * 1000;

import * as logs from "./logs";
import config, {triggerConfig, smtpPassword, oauthSecrets} from "./config";
import { requiresAPI, requiresRole } from "firebase-functions";
import Templates from "./templates";
import { Delivery, QueuePayload, ExtendedSendMailOptions } from "./types";
import { isSendGrid, setSmtpCredentials } from "./helpers";
import * as events from "./events";
import { SendGridTransport } from "./nodemailer-sendgrid";
import { preparePayload, setDependencies } from "./prepare-payload";

requiresAPI("firestore.googleapis.com", "Read the email queue and record delivery status");
requiresRole("roles/datastore.user");
requiresRole("roles/eventarc.eventReceiver");
requiresRole("roles/run.invoker");

let db: Firestore;
let transport: nodemailer.Transporter;
let templates: Templates;
let initialization: Promise<void> | undefined;

interface SendMailInfoLike {
  messageId: string | null;
  sendgridQueueId?: string | null;
  accepted: string[];
  rejected: string[];
  pending: string[];
  response: string | null;
}

/**
 * Initializes Admin SDK & SMTP connection if not already initialized.
 */
async function initialize() {
  if (!initialization) {
    initialization = (async () => {
      const app = getApps()[0] ?? initializeApp();
      db = getFirestore(app, config.database);
      transport = await transportLayer();
      if (config.templatesCollection) templates = new Templates(db.collection(config.templatesCollection));
      setDependencies(db, templates);
      events.setupEventChannel();
    })().catch(error => { initialization = undefined; throw error; });
  }
  await initialization;
}

async function transportLayer() {
  if (config.testing) {
    return nodemailer.createTransport({
      host: "127.0.0.1",
      port: 8132,
      secure: false,
      tls: {
        rejectUnauthorized: false,
      },
    });
  }
  if (isSendGrid(config)) {
    // use our custom transport
    return nodemailer.createTransport(
      new SendGridTransport({ apiKey: config.smtpPassword })
    );
  }
  // fallback to any other SMTP provider
  return setSmtpCredentials(config);
}

function validateFieldArray(field: string, array?: string[]) {
  if (!Array.isArray(array)) {
    throw new Error(`Invalid field "${field}". Expected an array of strings.`);
  }

  if (array.find((item) => typeof item !== "string")) {
    throw new Error(`Invalid field "${field}". Expected an array of strings.`);
  }
}


async function deliver(ref: DocumentReference): Promise<void> {
  // Fetch and fence ownership before preparing any SMTP side effect.
  const snapshot = await db.runTransaction(async tx => {await assertLegacyEmailRelease(tx, db); return tx.get(ref);});
  if (!snapshot.exists) {
    return;
  }

  let payload = snapshot.data();

  // Only attempt delivery if the payload is still in the "PROCESSING" state
  if (!payload.delivery || payload.delivery.state !== "PROCESSING") {
    return;
  }

  logs.attemptingDelivery(ref);

  // Prepare the Firestore document for delivery updates
  let smtpStarted = false, smtpAcknowledged = false;
  const update = {
    "delivery.attempts": FieldValue.increment(1),
    "delivery.endTime": FieldValue.serverTimestamp(),
    "delivery.error": null,
    "delivery.leaseExpireTime": null,
    "delivery.smtpSubmissionState": "not_submitted",
  };

  try {
    // Prepare the payload for delivery (e.g., formatting recipients, templates)
    payload = await preparePayload(payload);

    // Validate that there is at least one recipient (to, cc, or bcc)
    if (!payload.to.length && !payload.cc.length && !payload.bcc.length) {
      throw new Error(
        "Failed to deliver email. Expected at least 1 recipient."
      );
    }

    const mailOptions: ExtendedSendMailOptions = {
      from: payload.from || config.defaultFrom,
      replyTo: payload.replyTo || config.defaultReplyTo,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.message?.subject,
      text: payload.message?.text,
      html: payload.message?.html,
      headers: payload?.headers,
      attachments: payload.message?.attachments,
      categories: payload.categories,
      templateId: payload.sendGrid?.templateId,
      dynamicTemplateData: payload.sendGrid?.dynamicTemplateData,
      mailSettings: payload.sendGrid?.mailSettings,
      customArgs: payload.sendGrid?.customArgs,
      ipPoolName: payload.sendGrid?.ipPoolName,
    };

    const securedOptions = secureMailOptions(mailOptions);

    // Template/UID preparation may wait on Firestore. Recheck the actual owner,
    // delivery lease and document immediately before starting non-idempotent SMTP.
    const stillOwns = await db.runTransaction(async tx => {
      await assertLegacyEmailRelease(tx, db);
      const current = await tx.get(ref);
      const delivery = current.data()?.delivery as Delivery & {orchestrator?: string; smtpClaimId?: string; smtpSubmissionState?: string};
      if (!current.exists || !delivery || delivery.state !== "PROCESSING" || delivery.orchestrator === "temporal" || delivery.leaseExpireTime?.toMillis() !== snapshot.data().delivery.leaseExpireTime?.toMillis()) return false;
      if (!delivery.smtpClaimId || delivery.smtpClaimId !== snapshot.data().delivery.smtpClaimId || delivery.smtpSubmissionState !== "not_submitted") return false;
      if (!delivery.leaseExpireTime || delivery.leaseExpireTime.toMillis() < Date.now()) {
        tx.update(ref, {"delivery.state": "ERROR", "delivery.error": "Lease expired before SMTP submission.", "delivery.endTime": FieldValue.serverTimestamp()});
        return false;
      }
      tx.update(ref, {"delivery.smtpSubmissionState": "started", "delivery.smtpSubmissionStartedAt": FieldValue.serverTimestamp()});
      return true;
    });
    if (!stillOwns) return;
    logs.info("Sending queued email", { documentPath: ref.path });
    smtpStarted = true;
    const result = (await transport.sendMail(securedOptions)) as any;

    smtpAcknowledged = true;
    update["delivery.smtpSubmissionState"] = "accepted";
    const info: SendMailInfoLike = {
      messageId: result.messageId || null,
      sendgridQueueId: result.queueId || null,
      accepted: result.accepted || [],
      rejected: result.rejected || [],
      pending: result.pending || [],
      response: result.response || null,
    };

    // Update Firestore document to indicate success
    update["delivery.state"] = "SUCCESS";
    update["delivery.info"] = info;

    logs.delivered(ref, info);
  } catch (e) {
    // Update Firestore document to indicate failure
    update["delivery.state"] = "ERROR";
    update["delivery.smtpSubmissionState"] = smtpAcknowledged ? "accepted" : smtpStarted ? "unknown" : "not_submitted";
    update["delivery.error"] = e.toString();
    logs.deliveryError(ref, e);
  }

  // Update the Firestore document transactionally to allow retries (#48)
  return db.runTransaction(async transaction => {
    const current = await transaction.get(ref);
    const delivery = current.data()?.delivery as Delivery & {orchestrator?: string; smtpClaimId?: string; smtpSubmissionState?: string};
    if (!current.exists || !delivery || delivery.orchestrator === "temporal" || (delivery.state !== "PROCESSING" && !(delivery.state === "ERROR" && delivery.smtpSubmissionState === "unknown")) || delivery.smtpClaimId !== snapshot.data().delivery.smtpClaimId || delivery.leaseExpireTime?.toMillis() !== snapshot.data().delivery.leaseExpireTime?.toMillis()) return;
    transaction.update(ref, update);
  });
}

async function processWrite(
  change: functions.Change<DocumentSnapshot>
): Promise<void> {
  const ref = change.after.ref;

  // A quick check to avoid doing unnecessary transaction work.
  // If the record state is SUCCESS or ERROR we don't need to do anything
  // transactionally here since these are the 'final' delivery states.
  // Note: we still check these again inside the transaction in case the state has
  // changed while the transaction was inflight.
  if (change.after.exists) {
    const payloadAfter = change.after.data() as QueuePayload;
    // Once admitted, the durable receipt owns delivery even during a flag rollback.
    if ((payloadAfter.delivery as Delivery & {orchestrator?: string})?.orchestrator === "temporal") return;
    // The email has already been delivered, so we don't need to do anything.
    if (
      payloadAfter &&
      payloadAfter.delivery &&
      payloadAfter.delivery.state === "SUCCESS"
    ) {
      return;
    }

    // The email has previously failed to be delivered, so we can't do anything.
    if (
      payloadAfter &&
      payloadAfter.delivery &&
      payloadAfter.delivery.state === "ERROR"
    ) {
      return;
    }
  }

  const decision = await db.runTransaction<{
    attemptDelivery: boolean;
    publish?: () => Promise<unknown>;
  }>(
    async (transaction) => {
      const snapshot = await transaction.get(ref);
      // Record no longer exists, so no need to attempt delivery.
      if (!snapshot.exists) {
        return {attemptDelivery: false};
      }

      await assertLegacyEmailRelease(transaction, db);
      const payload = snapshot.data() as QueuePayload;
      if ((payload.delivery as Delivery & {orchestrator?: string})?.orchestrator === "temporal") return {attemptDelivery: false};

      // We expect the payload to contain a message object describing the email
      // to be sent, or a template, or a SendGrid template.
      // If it doesn't and is not a template, we can't do anything.
      if (
        typeof payload.message !== "object" &&
        !payload.template &&
        typeof payload.sendGrid !== "object"
      ) {
        logs.invalidMessage(payload.message);
        return {attemptDelivery: false};
      }

      // The record has most likely just been created by a client, so we need to
      // initialize the delivery state.
      if (!payload.delivery) {
        const startTime = Timestamp.fromDate(new Date());
        const delivery: Partial<Delivery> = {
          startTime: startTime,
          state: "PENDING",
          attempts: 0,
          error: null,
        };
        if (config.TTLExpireType && config.TTLExpireType !== "never") {
          delivery.expireAt = getExpireAt(startTime);
        }
        transaction.update(ref, { delivery });
        // We've updated the payload, so we need to attempt delivery, but we
        // don't want to do it in this transaction. Since the transaction will
        // update the record again the cloud function will be triggered again
        // and delivery will be attempted at that point.
        return {attemptDelivery: false};
      }

      const state = payload.delivery.state;
      // The email has already been delivered, so we don't need to do anything.
      if (state === "SUCCESS") {
        return {attemptDelivery: false, publish: () => events.recordSuccessEvent(change)};
      }

      // The email has previously failed to be delivered, so we can't do anything.
      if (state === "ERROR") {
        return {attemptDelivery: false, publish: () => events.recordErrorEvent(change, payload, payload.delivery.error)};
      }

      if (state === "PROCESSING") {
        const expired = !payload.delivery.leaseExpireTime || payload.delivery.leaseExpireTime.toMillis() < Date.now();
        if (expired) {

          // The lease has expired, so we should not attempt to deliver the email again,
          // but we set the state to ERROR so clients can see that the email failed.
          transaction.update(ref, {
            "delivery.state": "ERROR",
            // Keeping error to avoid any breaking changes in the next minor update.
            // Error to be removed for the next major release.
            "delivery.error": "Message processing lease expired.",
            "delivery.smtpSubmissionState": (payload.delivery as Delivery & {smtpSubmissionState?: string}).smtpSubmissionState === "not_submitted" ? "not_submitted" : "unknown",
          });
        }
        // Return only the winning attempt's event plan; retries publish nothing.
        return {attemptDelivery: false, publish: async () => {
          await events.recordProcessingEvent(change);
          if (expired) await events.recordErrorEvent(change, payload, "Message processing lease expired.");
        }};
      }

      if (state === "PENDING" || state === "RETRY") {
        const submission = (payload.delivery as Delivery & {smtpSubmissionState?: string}).smtpSubmissionState;
        if ((submission && submission !== "not_submitted") || (!submission && (state === "RETRY" || (payload.delivery.attempts || 0) > 0)))
          throw new Error("EMAIL_SMTP_OUTCOME_REQUIRES_REVIEW");
        await assertNewLegacyEmailClaim(transaction, db, snapshot, config.mailCollection);
        const eventFn =
          state === "PENDING"
            ? events.recordPendingEvent
            : events.recordRetryEvent;

        // We can attempt to deliver the email in these states, so we set the state to PROCESSING
        // and set a lease time to prevent delivery from being attempted forever.
        transaction.update(ref, {
          "delivery.state": "PROCESSING",
          "delivery.smtpClaimId": randomUUID(),
          "delivery.smtpSubmissionState": "not_submitted",
          "delivery.leaseExpireTime": Timestamp.fromMillis(Date.now() + deliveryLeaseMillis),
        });
        return {attemptDelivery: true, publish: () => eventFn(change, payload)};
      }

      // We don't know what the state is, so we can't do anything. This should never happen.
      return {attemptDelivery: false};
    }
  );

  // Firestore can rerun the callback. Only its committed result may publish.
  // Handler retries can still lose or duplicate publications; SMTP is not atomic with Eventarc.
  let publicationFailed = false;
  let publicationError: unknown;
  try {
    await decision.publish?.();
  } catch (error) {
    publicationFailed = true;
    publicationError = error;
  }
  try {
    // A failed event must not strand a newly committed PROCESSING claim unsent.
    if (decision.attemptDelivery) await deliver(ref);
  } catch (deliveryError) {
    if (publicationFailed)
      throw Object.assign(new Error("Email publication and delivery both failed"), {errors: [publicationError, deliveryError]});
    throw deliveryError;
  }
  if (publicationFailed) throw publicationError;
}

export const processQueue = onDocumentWritten(
  {
    document: expr`${triggerConfig.mailCollection}/{documentId}`,
    database: triggerConfig.database,
    region: triggerConfig.location,
    secrets: [smtpPassword, ...oauthSecrets],
    timeoutSeconds: 120,
    maxInstances: 10,
    concurrency: typeof systemOptions.cpu === "number" && systemOptions.cpu < 1 || systemOptions.cpu === "gcf_gen1" ? 1 : 20,
    retry: true,
    ...systemOptions,
  },
  async (event) => {
    if (!event.data) return;
    const authoritativeApp = getApps()[0] ?? initializeApp();
    const authoritativeDb = getFirestore(authoritativeApp, config.database);
    emailCaptureProfile(authoritativeApp.options.projectId);
    if (process.env.TASK_ORCHESTRATOR_EMAILS === "temporal") {
      if (!event.data.after.exists) return;
      const app = getApps()[0] ?? initializeApp();
      const projectId = app.options.projectId || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
      if (!projectId) throw new Error("Email orchestration project is missing");
      await enqueueTemporalEmail(getFirestore(app, config.database), event.data.after.ref.path, projectId,
        config.TTLExpireType && config.TTLExpireType !== "never" ? getExpireAt : undefined, getEmailExpiryPolicy());
      return;
    }
    if (event.data.after.data()?.delivery?.orchestrator === "temporal") return;
    const app = getApps()[0] ?? initializeApp();
    const ownershipDb = getFirestore(app, config.database);
    await ownershipDb.runTransaction(tx => assertLegacyEmailRelease(tx, ownershipDb));
    assertLegacyEmailTransportAllowed(app.options.projectId);
    await initialize();
    logs.start();

    const change = event.data;

    if (!change.before.exists) {
      await events.recordStartEvent(change);
    }

    try {
      await processWrite(change);
    } catch (err) {
      await events.recordErrorEvent(
        change,
        change.after.data(),
        `Unhandled error occurred during processing: ${err.message}`
      );
      logs.error(err);
      throw err;
    }

    await events.recordCompleteEvent(change);
    logs.complete();
  }
);
