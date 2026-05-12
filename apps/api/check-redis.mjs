import RedisMock from 'ioredis-mock';

const r = new RedisMock();

// Try WATCH/MULTI/EXEC for an optimistic conditional delete.
await r.set('foo', JSON.stringify({callId: 'X'}), 'PX', 60000);
await r.watch('foo');
const raw = await r.get('foo');
const parsed = JSON.parse(raw);
const tx = r.multi();
if (parsed.callId === 'X') {
  tx.del('foo');
}
const res = await tx.exec();
console.log('exec result:', res);
console.log('after:', await r.get('foo'));

// Try with a mismatch.
await r.set('foo', JSON.stringify({callId: 'Y'}), 'PX', 60000);
await r.watch('foo');
const raw2 = await r.get('foo');
const parsed2 = JSON.parse(raw2);
const tx2 = r.multi();
if (parsed2.callId === 'X') {
  tx2.del('foo');
}
const res2 = await tx2.exec();
console.log('exec result (mismatch):', res2);
console.log('after (mismatch):', await r.get('foo'));

await r.quit();
