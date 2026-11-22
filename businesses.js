// Business identity belongs to Quote. CRM stages and follow-up settings belong
// to each independent HUB and must be read from that HUB before automation.
export const businesses = Object.freeze({
  'sentire-ffw': Object.freeze({
    name: 'Sentire FFW', module: 'freight', currency: 'USD',
    hubUrl: 'https://hub.sentireffw.com', hubTenantId: 'sffw',
    sourceUrl: 'https://docs.google.com/spreadsheets/d/12IAadiPtazD2pIDHD8RKBzXYk_m-tauS/edit',
    dataModel: 'routes',
  }),
  'sentire-marine': Object.freeze({
    name: 'Sentire Marine', module: 'marine', currency: 'USD',
    hubUrl: 'https://hub.sentiremarine.com.ar', hubTenantId: null,
    sourceUrl: 'https://docs.google.com/spreadsheets/d/1o2T0kZWthK9jKF1an_NcGLfsopW2mh55/edit',
    dataModel: 'parts',
  }),
});

export function businessConfig(tid) {
  if (!Object.hasOwn(businesses, tid)) return null;
  return { ...businesses[tid], setupRequired: true, pipelineSource: 'hub',
    followupSource: 'hub', timeZone: 'America/Argentina/Buenos_Aires' };
}

export async function seedBusiness(tid, ref, timestamp) {
  const config = businessConfig(tid);
  if (!config) return false;
  // Transaction prevents concurrent first opens from overwriting an existing
  // business. Never seed SCB customs taxes or Shenzhen freight into these tenants.
  await ref.firestore.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) tx.create(ref, { ...config, logo: '', schemaVersion: 1,
      createdAt: timestamp(), updatedAt: timestamp() });
  });
  return true;
}
