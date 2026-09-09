import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDirs, worklistPaths, enqueueEnvelopeIdempotent, envelopeToItem, withdrawEnvelopeIdempotent, getArchivedItem, listItems, putItem } from './store.ts';

test('durable withdrawal fences enqueue before and after process death', () => {
  const root=mkdtempSync(join(tmpdir(),'worklist-withdraw-'));
  try {
    const p=worklistPaths(root);ensureDirs(p);
    const env={id:'agent-proof-blocked-1',summary:'question',body:'raw context',source:'familiar-agents'};
    withdrawEnvelopeIdempotent(p,env);
    expect(getArchivedItem(p,env.id)?.withdrawn).toBe(true);
    expect(enqueueEnvelopeIdempotent(p,env).created).toBe(false);
    expect(listItems(p)).toEqual([]);
    // Simulate an old process paused AFTER its pre-enqueue existence check.
    putItem(p,envelopeToItem(env));
    expect(listItems(worklistPaths(root))).toEqual([]);
    expect(getArchivedItem(p,env.id)?.withdrawn).toBe(true);
    const next={...env,id:'agent-proof-blocked-2'};
    expect(enqueueEnvelopeIdempotent(p,next).created).toBe(true);
    withdrawEnvelopeIdempotent(p,next);withdrawEnvelopeIdempotent(p,next);
    expect(listItems(p)).toEqual([]);
    expect(()=>withdrawEnvelopeIdempotent(p,{...env,id:'../escape'})).toThrow();
  } finally {rmSync(root,{recursive:true,force:true});}
});
