// CONTROLLED workload/result only. Actual parent IPC, original ChildProcess and
// CLOSE are native local OS. This never grants real host resources or calls SDKs.
const fs = require('node:fs');
const deadline = setTimeout(() => process.exit(2), 10000);
process.once('message', (input) => {
  clearTimeout(deadline);
  if (process.env.URM_HOST_CAPTURE)
    fs.writeFileSync(process.env.URM_HOST_CAPTURE, JSON.stringify(input), { mode: 0o600 });
  const value = {
    v: 1,
    id: input.id,
    kind: 'success',
    value: { alreadyProcessed: true, youtubeSuccessfulAcquisitionAuthority: 'cookie_provider' },
    flags: { youtubeCookieRefreshAttempted: true, youtubeCookieRefreshSucceeded: true },
  };
  if (process.env.URM_HOST_FIXTURE === 'private') value.privateDiagnostic = 'CONTROLLED_PRIVATE_DIAGNOSTIC';
  process.send(value);
  if (process.env.URM_HOST_FIXTURE === 'duplicate') process.send(value);
  setTimeout(() => process.exit(0), 80);
});
