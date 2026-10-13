// Provider-aware authentication verification. No envelope, SMTP DATA or mail-send endpoint is used.
const fs = require('node:fs');
const {
  verifyEmailTransportNoSend,
} = require('/workspace/function-kits/firestore-send-email/lib/temporal/provider.js');
const descriptor = JSON.parse(fs.readFileSync(process.env.EMAIL_EGRESS_DESCRIPTOR_PATH, 'utf8'));
verifyEmailTransportNoSend(descriptor)
  .then((verification) =>
    console.log(
      JSON.stringify({
        projectId: process.env.FIREBASE_PROJECT_ID,
        buildId: process.env.TEMPORAL_BUILD_ID,
        result: 'passed',
        provider: verification.provider,
        tlsVerified: verification.tlsVerified,
        authenticationVerified: verification.authenticationVerified,
        mailPermissionVerified: verification.mailPermissionVerified,
        noMessageSent: true,
        verifiedAt: new Date().toISOString(),
      })
    )
  )
  .catch(() => {
    console.error('Private email TLS/authentication canary failed; no message was sent and cutover remains blocked.');
    process.exitCode = 1;
  });
