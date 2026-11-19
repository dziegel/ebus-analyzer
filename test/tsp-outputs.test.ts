import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCompiled } from '../src/tsp/outputs.ts';

const HEADER = 'type,circuit,level,name,comment,qq,zz,pbsb,id,*name,part,type,divisor/values,unit,comment';
const csv = (line: string) => `${HEADER}\n${line}\n`;

test('compiled files are selected per device, user files first', () => {
  const out = {
    'broadcast.csv': csv('u,Broadcast,,Outside,,,fe,b516,01,value,,D2B,,°C,'),
    'vaillant/08.hmu.csv': csv('r,,,FlowTemp,,,,b51a,05ff3220,value,,D2C,,,'),
    'vaillant/08.bai.csv': csv('r,,,FlowTemp,,,,b51a,05ff3220,value,,D1C,,,'),
    'vaillant/26.vr_71.csv': csv('r,,,X,,,,b509,0d0100,value,,UCH,,,'),
    'vaillant/08.bai.csv.extra': 'ignored',
    'drafts/08.hmu.csv': csv('r,,,Draft,,,,b509,0d0200,value,,UCH,,,'),
  };
  const devices = [{ address: 8, manufacturer: 'Vaillant', deviceId: 'HMU00', sw: '0308', hw: '0403' }];
  const user = new Set(['drafts/08.hmu.csv']);
  const files = selectCompiled(out, devices, user).map((f) => f.path);
  assert.deepEqual(files, ['typespec:drafts/08.hmu.csv', 'typespec:broadcast.csv', 'typespec:vaillant/08.hmu.csv']);
  const draft = selectCompiled(out, devices, user)[0]!;
  assert.equal(draft.local, true);
  assert.deepEqual(draft.parsed.messages[0]!.zz, [8]);
  assert.equal(selectCompiled(out, []).length, 5); // without devices: everything
});
