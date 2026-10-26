import { execFileSync } from 'node:child_process';
import { it, expect } from 'vitest';
import source from './edu-owned-process.py?raw';
it('guest receipts bind exact PID/startTicks, refuse missing owners and keep the revoke request narrow', () => {
  const program = `import json,tempfile,threading,time,uuid
from pathlib import Path
m={'__name__':'owned_receipt_test'}
exec(compile(${JSON.stringify(source)},'<edu-owned-process>','exec'),m)
with tempfile.TemporaryDirectory() as root:
 m['BASE']=Path(root)
 boot=str(uuid.uuid4());m['boot_identity']=lambda:boot
 identity={'workspaceId':'space','environmentId':'sandbox','projectId':'project','appInstanceId':str(uuid.uuid4())}
 expected={'identity':identity,'sourceSha256':'a'*64}
 helper={'pid':100,'startTicks':'10'};leader={'pid':200,'startTicks':'20'}
 path=m['receipt_path'](identity['appInstanceId'])
 value={'schemaVersion':1,**expected,'bootId':boot,'helper':helper,'leader':leader,'members':[leader],'cleanupConfirmed':True}
 m['atomic'](path,value)
 # Reused PIDs with different start-times are not the original owned processes.
 current={100:({'pid':100,'startTicks':'99'},1,100),200:({'pid':200,'startTicks':'99'},1,200)}
 m['process_identity']=lambda pid:current.get(pid)
 assert m['reconcile'](expected)['cleanupConfirmed'] is True
 value['cleanupConfirmed']=False;m['atomic'](path,value)
 try:m['reconcile'](expected);raise AssertionError('adopted a reused helper PID')
 except m['RecoveryError'] as error:assert error.code=='verification_recovery_helper_lost'
 current={100:(helper,1,100),200:(leader,100,200)}
 def owned_helper_finishes():
  control=path.with_suffix('.revoke')
  while not control.exists():time.sleep(.005)
  assert json.loads(control.read_text())=={'appInstanceId':identity['appInstanceId']}
  current.clear();value['cleanupConfirmed']=True;m['atomic'](path,value)
 thread=threading.Thread(target=owned_helper_finishes);thread.start()
 assert m['reconcile'](expected)['leader']==leader
 thread.join()
 value['members']=[];m['atomic'](path,value)
 try:m['reconcile'](expected);raise AssertionError('accepted incomplete process history')
 except m['RecoveryError'] as error:assert error.code=='verification_recovery_receipt_invalid'
 print('owned receipt simulated proc boundary passed')
`;
  expect(execFileSync('python3', ['-I', '-'], { input: program, encoding: 'utf8', timeout: 3000 })).toContain(
    'simulated proc boundary passed',
  );
});

it('boot replacement durably proves old owners ended without touching same-number current PIDs', () => {
  const program = `import json,tempfile,uuid,errno,copy
from pathlib import Path
m={'__name__':'owned_boot_test'}
exec(compile(${JSON.stringify(source)},'<edu-owned-process>','exec'),m)
with tempfile.TemporaryDirectory() as root:
 m['BASE']=Path(root);old=str(uuid.uuid4());new=str(uuid.uuid4())
 identity={'workspaceId':'space','environmentId':'sandbox','projectId':'project','appInstanceId':str(uuid.uuid4())}
 expected={'identity':identity,'sourceSha256':'a'*64};path=m['receipt_path'](identity['appInstanceId'])
 value={'schemaVersion':1,**expected,'bootId':old,'helper':{'pid':100,'startTicks':'10'},'leader':{'pid':200,'startTicks':'20'},'members':[{'pid':200,'startTicks':'20'}],'cleanupConfirmed':False}
 atomic=m['atomic'];atomic(path,value);m['boot_identity']=lambda:new
 def forbid(*args):raise AssertionError('looked up or signalled an old PID in the current boot')
 m['process_identity']=forbid;m['os'].kill=forbid
 result=m['reconcile'](expected)
 assert result['bootId']==old and result['bootReplacement']=={'previousBootId':old,'currentBootId':new}
 stored=json.loads(path.read_text());assert stored['cleanupConfirmed'] is True and stored['bootReplacement']==result['bootReplacement']
 assert m['reconcile'](expected)==result
 # A changing boot cannot commit a proof or return success.
 atomic(path,value);reads=iter([new,str(uuid.uuid4())]);m['boot_identity']=lambda:next(reads)
 try:m['reconcile'](expected);raise AssertionError('accepted unstable boot')
 except m['RecoveryError'] as error:assert error.code=='verification_recovery_boot_changed'
 assert json.loads(path.read_text())==value
 atomic(path,value);reads=iter([new,new,str(uuid.uuid4())]);m['boot_identity']=lambda:next(reads)
 try:m['reconcile'](expected);raise AssertionError('confirmed after boot changed across fsync')
 except m['RecoveryError'] as error:assert error.code=='verification_recovery_boot_changed'
 # Published proof must retain its explicit boot semantics; no arbitrary extra fields.
 m['boot_identity']=lambda:new
 for proof in [{'previousBootId':new,'currentBootId':old},{'previousBootId':old,'currentBootId':old},{'previousBootId':old,'currentBootId':new,'extra':True}]:
  atomic(path,{**value,'cleanupConfirmed':True,'bootReplacement':proof})
  try:m['reconcile'](expected);raise AssertionError('accepted invalid boot proof')
  except m['RecoveryError'] as error:assert error.code=='verification_recovery_receipt_invalid'
 # A failed actual fsync cannot become confirmed, including a failure after rename.
 for failAt in [1,2]:
  atomic(path,value);m['boot_identity']=lambda:new;native=m['os'].fsync;calls=[0]
  def failed_fsync(fd):
   calls[0]+=1
   if calls[0]==failAt:raise OSError(errno.EIO,'Input/output error')
   return native(fd)
  m['os'].fsync=failed_fsync
  try:
   try:m['reconcile'](expected);raise AssertionError('accepted failed fsync')
   except m['RecoveryError'] as error:assert error.code=='verification_recovery_receipt_unconfirmed'
  finally:m['os'].fsync=native
  assert m['reconcile'](expected)['cleanupConfirmed'] is True
 # Exact identity/source and receipt validation precede the boot-replaced path.
 for bad in [{'identity':{**identity,'workspaceId':'foreign'},'sourceSha256':'a'*64},{**expected,'sourceSha256':'b'*64}]:
  atomic(path,value)
  try:m['reconcile'](bad);raise AssertionError('accepted foreign identity/source')
  except m['RecoveryError'] as error:assert error.code=='verification_recovery_receipt_mismatch'
 atomic(path,{**value,'unexpected':True})
 try:m['reconcile'](expected);raise AssertionError('accepted invalid receipt')
 except m['RecoveryError'] as error:assert error.code=='verification_recovery_receipt_invalid'
 path.unlink()
 try:m['reconcile'](expected);raise AssertionError('accepted missing receipt')
 except m['RecoveryError'] as error:assert error.code=='verification_recovery_receipt_missing'
 print('boot replacement boundary passed')
`;
  expect(execFileSync('python3', ['-I', '-'], { input: program, encoding: 'utf8', timeout: 3000 })).toContain(
    'boot replacement boundary passed',
  );
});
