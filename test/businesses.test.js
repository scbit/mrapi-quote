import test from 'node:test';
import assert from 'node:assert/strict';
import { seedBusiness, businessConfig } from '../businesses.js';

function database() {
  const docs = new Map();
  const firestore = { async runTransaction(fn) {
    await fn({ get: async ref => ({ exists: docs.has(ref.id),data:()=>docs.get(ref.id) }),
      create: (ref, data) => { assert.equal(docs.has(ref.id), false); docs.set(ref.id, data); } });
  } };
  return { docs, ref: id => ({ id, firestore }) };
}

test('new businesses stay isolated and first-open does not overwrite changes', async () => {
  const db = database();
  await seedBusiness('sentire-ffw', db.ref('sentire-ffw'), () => 100);
  await seedBusiness('sentire-marine', db.ref('sentire-marine'), () => 101);
  db.docs.get('sentire-ffw').name = 'Nombre editado';
  await seedBusiness('sentire-ffw', db.ref('sentire-ffw'), () => 200);
  assert.equal(db.docs.size, 2);
  assert.equal(db.docs.get('sentire-ffw').name, 'Nombre editado');
  assert.equal(db.docs.get('sentire-ffw').createdAt, 100);
  assert.equal(db.docs.get('sentire-marine').createdAt, 101);
  assert.notEqual(db.docs.get('sentire-ffw').hubUrl, db.docs.get('sentire-marine').hubUrl);
});

test('existing SCB/SST and unknown IDs retain legacy behavior without writes', async () => {
  const db = database();
  for (const id of ['sentire-customs-broker', 'shenzhen-sentire-trading', 'unknown', '__proto__']) {
    assert.equal(await seedBusiness(id, db.ref(id), () => 0), false);
  }
  assert.equal(db.docs.size, 0);
});

test('new business pricing remains gated and pipelines are not copied', () => {
  for (const id of ['sentire-marine', 'sentire-ffw']) {
    const config = businessConfig(id);
    assert.equal(config.setupRequired, true);
    assert.equal(config.currency, 'USD');
    assert.equal(config.pipelineSource, 'hub');
    assert.equal(config.followupSource, 'hub');
    assert.equal(Object.hasOwn(config, 'stages'), false);
    assert.equal(Object.hasOwn(config, 'taxProfiles'), false);
  }
});
