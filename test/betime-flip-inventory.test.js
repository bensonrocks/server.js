'use strict';
const {test}=require('node:test'); const assert=require('node:assert/strict');
const bs=require('../lib/betime-stock');
test('flip cutoff helpers: pool shared across Betime names, non-Betime unchanged',()=>{
  const ids=['betime','BETIME ECOM','Betime Online','ACME'];
  assert.equal(bs.resolvePoolClientId('BETIME ECOM',ids),'betime');
  assert.equal(bs.resolvePoolClientId('Betime Online',ids),'betime');
  assert.equal(bs.resolvePoolClientId('[BETIME] - BETIME',ids),'betime');
  assert.equal(bs.resolvePoolClientId('ACME',ids),'ACME');
});
test('B2B/B2C mapping: OneCart=B2C, manual/GI=B2B',()=>{
  assert.equal(bs.orderChannelType({uploaded_by:'onecart-sync'},{}),'B2C');
  assert.equal(bs.orderChannelType({uploaded_by:'demo'},{}),'B2B');
  assert.equal(bs.orderChannelType({}, {onecart_id:'1'}),'B2C');
});
test('labelled only B2B, unlabelled only B2C, wrong-type-only',()=>{
  const row={stock_qty:10,labelled_qty:10,unlabelled_qty:0};
  assert.equal(bs.typedState(row,2,'B2B').state,'ok');
  const w=bs.typedState(row,2,'B2C'); assert.equal(w.state,'none'); assert.equal(w.wrongTypeOnly,true);
  const row2={stock_qty:5,labelled_qty:0,unlabelled_qty:5};
  assert.equal(bs.typedState(row2,2,'B2C').state,'ok'); assert.equal(bs.typedState(row2,2,'B2B').wrongTypeOnly,true);
});
test('upload parsing: stock_type aliases',()=>{
  assert.equal(bs.parseStockType('Labelled'),'labelled'); assert.equal(bs.parseStockType('unlabelled'),'unlabelled');
  assert.equal(bs.stockTypeOfRow({stock_type:'Labelled'}),'labelled'); assert.equal(bs.stockTypeOfRow({type:'B2C'}),'unlabelled'); assert.equal(bs.stockTypeOfRow({}),'');
});
test('legacy untyped stock does not read as wrong-type',()=>{ const s=bs.typedState({stock_qty:5,labelled_qty:0,unlabelled_qty:0},2,'B2C'); assert.equal(s.state,'ok'); assert.equal(s.untyped,true); });
