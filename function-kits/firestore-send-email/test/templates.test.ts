import Templates from '../src/templates';
jest.mock('../src/logs', () => ({registeredPartial: jest.fn(), noPartialAttachmentSupport: jest.fn(), checkingMissingTemplate: jest.fn(), foundMissingTemplate: jest.fn(), templatesLoaded: jest.fn()}));
function snapshot(docs: any[]) {return {docs: docs.map(([id, data]) => ({id, data: () => data}))};}
function fixture(initial: any[]) {
  let update: any, error: any;
  const collection: any = {onSnapshot: (u: any, e: any) => {update = u; error = e;}, get: jest.fn(async () => snapshot(initial))};
  const templates = new Templates(collection);
  update(snapshot(initial));
  return {templates, update, error, collection};
}
test('HTML templates escape data while subjects retain plain text', async () => {
  const {templates} = fixture([['welcome', {subject: 'Hello {{name}}', html: '<p>{{name}}</p>'}]]);
  const result = await templates.render('welcome', {name: '<Jane>'});
  expect(result.subject).toBe('Hello <Jane>');
  expect(result.html).toBe('<p>&lt;Jane&gt;</p>');
});
test('deleted templates are not rendered from stale cache', async () => {
  const {templates, update, collection} = fixture([['welcome', {text: 'Hello'}]]);
  update(snapshot([]));
  collection.get.mockResolvedValue(snapshot([]));
  await expect(templates.render('welcome', {})).rejects.toThrow('non-existent template');
});
test('new template absent from listener is loaded before rendering', async () => {
  const {templates, collection} = fixture([]);
  collection.get.mockResolvedValue(snapshot([['new', {text: 'Hello {{name}}'}]]));
  await expect(templates.render('new', {name: 'Jane'})).resolves.toMatchObject({text: 'Hello Jane'});
});
test('listener error rejects rendering promptly', async () => {
  let onError: any;
  const collection: any = {onSnapshot: (_update: any, err: any) => {onError = err;}};
  const templates = new Templates(collection);
  const rendering = templates.render('welcome', {});
  onError(new Error('Permission denied'));
  await expect(rendering).rejects.toThrow('Permission denied');
});
