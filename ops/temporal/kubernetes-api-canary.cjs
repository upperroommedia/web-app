// Read-only authenticated Kubernetes reachability from the actual database network profile.
const https = require('node:https');
const fs = require('node:fs');
const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'utf8');
async function probe(endpoint) {
  const value = await new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: endpoint.cidr.split('/')[0],
        port: endpoint.port,
        servername: 'kubernetes.default.svc',
        ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        path: `/api/v1/namespaces/${process.env.CANARY_NAMESPACE}/pods/${process.env.CANARY_POD_NAME}`,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('API read-only authentication failed'));
          return;
        }
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1048576) req.destroy(new Error('Response exceeded metadata bound'));
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Invalid API response'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('API timeout')));
    req.on('error', reject);
  });
  if (value.metadata?.uid !== process.env.CANARY_POD_UID || value.metadata?.namespace !== process.env.CANARY_NAMESPACE)
    throw new Error('Wrong private API identity');
}
Promise.all(JSON.parse(process.env.CANARY_ENDPOINTS).map(probe))
  .then(() => console.log('Private Kubernetes API TLS, identity and scoped read-only authentication verified.'))
  .catch(() => {
    console.error('Private Kubernetes API canary failed; no database readiness accepted.');
    process.exitCode = 1;
  });
