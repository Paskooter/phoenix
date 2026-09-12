// Pins for the two production adapters and the runtime used by the checked-in
// production fixture images. Capture metadata is a claim; the comparator checks
// it against these pins instead of accepting self-reported provenance.
export const PRODUCTION_PROVENANCE = Object.freeze({
  driverSha256: '5371a42e9c0644cf75ad5e83225f62dcf18a97baf3ebd876352d6c7d5fb689f4',
  implementations: Object.freeze({
    original: Object.freeze({ runtime: 'v8.9.4', adapterSha256: 'df1b290d26d1b8a614d904acf84f2a895ea0ae310995328f59a18745f8500194' }),
    phoenix: Object.freeze({ runtime: 'v22.22.0', adapterSha256: 'bfb3a8793430475ca545cbbc3983e0934e03fe7b7ca2dc4feb2ae46ff373f9ee' }),
  }),
});
