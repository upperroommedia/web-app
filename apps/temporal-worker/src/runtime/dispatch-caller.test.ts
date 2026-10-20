import { generateKeyPairSync, sign } from 'node:crypto';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { observeDispatchCallerAuthorization } from './dispatch-caller';
const buildId = 'a'.repeat(40);
const binding = { projectId: 'urm-app-staging', buildId,
  audience: `https://urm-dispatch-${buildId.slice(0,20)}-251680231116.us-central1.run.app`,
  eventSubject: '12345678901234567891', schedulerSubject: '12345678901234567892' };
const payload = (): TokenPayload => ({ iss: 'https://accounts.google.com', sub: binding.eventSubject,
  aud: binding.audience, iat: Math.floor(Date.now()/1000)-10, exp: Math.floor(Date.now()/1000)+600,
  email: `td-e-${buildId.slice(0,20)}@urm-app-staging.iam.gserviceaccount.com`, email_verified: true });
const signal = () => new AbortController().signal;
const header = { authorization: 'Bearer fixture.header.signature' };
test('actual Google SDK signature verification accepts the exact caller and denies a tampered signed payload', async()=>{
 const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
 const encode = (v:unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
 const unsigned = `${encode({alg:'RS256',kid:'controlled-local'})}.${encode(payload())}`;
 const jwt = `${unsigned}.${sign('RSA-SHA256',Buffer.from(unsigned),privateKey).toString('base64url')}`;
 const client = new OAuth2Client();
 const authorization = observeDispatchCallerAuthorization(binding, async (token,audience) =>
  (await client.verifySignedJwtWithCertsAsync(token, { 'controlled-local': publicKey.export({type:'spki',format:'pem'}).toString() }, audience, ['https://accounts.google.com'], 3600)).getPayload());
 await expect(authorization.verify({authorization:`Bearer ${jwt}`},'event',signal())).resolves.toEqual({kind:'event',subject:binding.eventSubject});
 const tampered=jwt.split('.');tampered[1]=encode({...payload(),sub:binding.schedulerSubject});
 await expect(authorization.verify({authorization:`Bearer ${tampered.join('.')}`},'event',signal())).rejects.toThrow(/^DISPATCH_CALLER_UNCONFIRMED$/);
 await authorization.drain();
});
test.each(['sub','email','aud','iss','email_verified','exp','iat'])('denies verified payload with foreign or invalid %s',async field=>{
 const value=payload();Object.assign(value,{[field]:field==='exp'?0:field==='iat'?Date.now():field==='email_verified'?false:field==='sub'?binding.schedulerSubject:'foreign'});
 const authorization=observeDispatchCallerAuthorization(binding,async()=>value);
 await expect(authorization.verify(header,'event',signal())).rejects.toThrow(/^DISPATCH_CALLER_UNCONFIRMED$/);await authorization.drain();
});
test.each([{}, {authorization:['Bearer a.b.c']}, {authorization:'Bearer fixture.header.signature','x-serverless-authorization':'Bearer stripped'},
 {'x-serverless-authorization':'Bearer stripped'}, {authorization:'Bearer a.b.'}, {authorization:`Bearer ${'x'.repeat(17000)}`}])('unsupported or ambiguous credentials never reach verification',async headers=>{
 const verify=jest.fn().mockResolvedValue(payload());const auth=observeDispatchCallerAuthorization(binding,verify);
 await expect(auth.verify(headers,'event',signal())).rejects.toThrow(/^DISPATCH_CALLER_UNCONFIRMED$/);expect(verify).not.toHaveBeenCalled();await auth.drain();
});
test('route-specific subject prevents an event identity from authorizing Scheduler reconciliation',async()=>{
 const auth=observeDispatchCallerAuthorization(binding,async()=>payload());
 await expect(auth.verify(header,'scheduler',signal())).rejects.toThrow(/^DISPATCH_CALLER_UNCONFIRMED$/);await auth.drain();
});
test('whole timeout retains the occupied verification slot until real settlement and refuses late authorization',async()=>{
 let resolve!:(v:TokenPayload)=>void;const verify=jest.fn(()=>new Promise<TokenPayload>(yes=>{resolve=yes;}));
 const auth=observeDispatchCallerAuthorization(binding,verify,10);
 await expect(auth.verify(header,'event',signal())).rejects.toThrow(/^DISPATCH_CALLER_UNCONFIRMED$/);
 await expect(auth.verify(header,'event',signal())).rejects.toThrow(/^DISPATCH_CALLER_UNCONFIRMED$/);expect(verify).toHaveBeenCalledTimes(1);
 let drained=false;const closing=auth.drain().then(()=>{drained=true;});await new Promise<void>(yes=>setImmediate(yes));expect(drained).toBe(false);
 resolve(payload());await closing;
 await expect(auth.verify(header,'event',signal())).rejects.toThrow(/^DISPATCH_CALLER_UNCONFIRMED$/);
});
test('synchronous clock advance and caller cancellation after verification cannot authorize',async()=>{
 const now=Date.now,controller=new AbortController();
 try {
  const auth=observeDispatchCallerAuthorization(binding,async()=>{Date.now=()=>now()+20000;return payload();});
  await expect(auth.verify(header,'event',signal())).rejects.toThrow(/^DISPATCH_CALLER_UNCONFIRMED$/);await auth.drain();
 } finally {Date.now=now;}
 const auth=observeDispatchCallerAuthorization(binding,async()=>{controller.abort();return payload();});
 await expect(auth.verify(header,'event',controller.signal)).rejects.toThrow(/^DISPATCH_CALLER_UNCONFIRMED$/);await auth.drain();
});

