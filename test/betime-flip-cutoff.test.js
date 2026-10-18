'use strict';
// Cutoff logic mirrored from stampOnecartReferenceBatches predicate.
const {test}=require('node:test'); const assert=require('node:assert/strict');
function wantRef(store,batch){ return !store||store.mode!=='work'||(store.workFrom && String(batch.uploaded_at||'')<String(store.workFrom)); }
test('pre-flip reference stays, post-flip live, no re-file',()=>{
  const st={mode:'work',workFrom:'2026-10-19T00:00:00.000Z'};
  assert.equal(wantRef(st,{uploaded_at:'2026-10-18T00:00:00.000Z'}),true);
  assert.equal(wantRef(st,{uploaded_at:'2026-10-19T01:00:00.000Z'}),false);
  assert.equal(wantRef({mode:'reference',workFrom:st.workFrom},{uploaded_at:'2026-10-20T00:00:00.000Z'}),true);
});
