#!/usr/bin/env node
// Source recovery/concurrency tests against the same disposable PostgreSQL fixture
// used by canonical BizPortal scripts/test-fleet-finance-dsv-postgres.mjs.
// No shared DEV/PROD connections, no public app, no scheduler or WA send.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
const fleetRepo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const financeRepo=process.env.FLEET_QA_FINANCE_REPO||"/opt/bizportal-fleet-finance-diva-20261117";
const deps=process.env.FLEET_QA_DEPENDENCIES||"/opt/bizportal-20261117-audit-main-only";
const socket=process.env.FLEET_QA_PG_SOCKET||"/tmp/fleet-finance-dsv-qa-20261117/pgsocket";
if(!socket.startsWith("/tmp/fleet-finance-dsv-qa-")||!socket.endsWith("/pgsocket"))throw new Error("Only the private disposable QA socket is allowed");
const req=createRequire(path.join(deps,"package.json"));
function dependency(name){for(const manifest of ["package.json","artifacts/api-server/package.json","lib/db/package.json"]){try{return createRequire(path.join(deps,manifest))(name)}catch{}}throw new Error("Missing QA dependency "+name)}
const {Pool}=dependency("pg"),{build}=dependency("esbuild"),express=dependency("express");
const admin=new Pool({host:socket,database:"fleet_finance_qa",user:"postgres",max:2});
const financePool=new Pool({host:socket,database:"fleet_finance_qa",user:"fleet_finance_qa_api",max:8});
let sourcePool,server,scratch;
const passed=[],proof={};
const realFetch=globalThis.fetch;
async function test(name,fn){await fn();passed.push(name);process.stdout.write("PASS "+name+"\n")}
async function row(sql,values=[]){return (await admin.query(sql,values)).rows[0]}
async function expectError(fn,status){try{await fn();assert.fail("Expected rejection")}catch(error){assert.equal(error.status,status,String(error));return error}}
const timeout=(promise)=>Promise.race([promise,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error("QA barrier timed out")),10000);t.unref()})]);
try{
 const isolation=await row("SELECT current_database() db,inet_server_addr() addr");
 assert.equal(isolation.db,"fleet_finance_qa");assert.equal(isolation.addr,null);
 assert.equal((await row("SELECT count(*)::int n FROM public.accounting_entries WHERE source_event_id='fleet-cash-payment:1:990117301'")).n,1,"Run Finance boundary QA fixture first");
 if(!(await row("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='fleet_source_qa_api') found")).found)await admin.query("CREATE ROLE fleet_source_qa_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS");
 await admin.query("GRANT CONNECT ON DATABASE fleet_finance_qa TO fleet_source_qa_api");
 await admin.query("GRANT USAGE ON SCHEMA public TO fleet_source_qa_api");
 await admin.query("GRANT SELECT,INSERT,UPDATE ON public.fleet_cash_payments TO fleet_source_qa_api");
 await admin.query("GRANT SELECT,UPDATE ON public.fleet_outstanding TO fleet_source_qa_api");
 await admin.query("GRANT USAGE,SELECT ON SEQUENCE public.fleet_cash_payments_id_seq TO fleet_source_qa_api");
 if(!(await row("SELECT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_cash_payments' AND policyname='qa_source_workflow') found")).found)await admin.query("CREATE POLICY qa_source_workflow ON public.fleet_cash_payments TO fleet_source_qa_api USING(company_id=1) WITH CHECK(company_id=1)");
 if(!(await row("SELECT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='fleet_outstanding' AND policyname='qa_source_workflow') found")).found)await admin.query("CREATE POLICY qa_source_workflow ON public.fleet_outstanding TO fleet_source_qa_api USING(company_id=1) WITH CHECK(company_id=1)");
 await admin.query("UPDATE public.accounting_settings SET fleet_cash_account_id=49187,fleet_driver_receivable_account_id=49191,cash_journal_id=20 WHERE company_id=3");
 const runId=randomBytes(5).toString("hex");
 const lost={companyId:1,driverName:"QA Service Lost Response "+runId,driverExternalId:"qa-lost-"+runId,amount:5000,paymentDate:"2026-11-17",referenceNo:"QA-SERVICE-LOSS-"+runId,actor:"fleet-source-qa"};
 const race={companyId:1,driverName:"QA Service Cancel Race "+runId,driverExternalId:"qa-race-"+runId,amount:6000,paymentDate:"2026-11-17",referenceNo:"QA-SERVICE-RACE-"+runId,actor:"fleet-source-qa"};
 for(const [fixture,balance] of [[lost,50000],[race,60000]])fixture.outstandingId=(await row("INSERT INTO public.fleet_outstanding(company_id,driver_name,driver_external_id,outstanding_amount,status) VALUES(1,$1,$2,$3,'open') RETURNING id",[fixture.driverName,fixture.driverExternalId,balance])).id;
 sourcePool=new Pool({host:socket,database:"fleet_finance_qa",user:"fleet_source_qa_api",max:8});
 globalThis.__fleetFinanceQaPool=financePool;globalThis.__fleetSourceQaPool=sourcePool;
 scratch=await mkdtemp(path.join(tmpdir(),"fleet-source-recovery-qa-"));
 const plugin=(filter,globalName)=>({name:globalName,setup(b){b.onResolve({filter},()=>({path:"isolated-pool",namespace:globalName}));b.onLoad({filter:/.*/,namespace:globalName},()=>({contents:"export const pool=globalThis."+globalName+";",loader:"js"}))}});
 await build({entryPoints:[path.join(financeRepo,"artifacts/api-server/src/routes/fleet-finance-integration.ts")],outfile:path.join(scratch,"receiver.cjs"),platform:"node",target:"node22",format:"cjs",bundle:true,plugins:[plugin(/^@workspace\/db$/,"__fleetFinanceQaPool")],nodePaths:[path.join(deps,"node_modules"),path.join(deps,"artifacts/api-server/node_modules")],logLevel:"silent"});
 await build({entryPoints:[path.join(fleetRepo,"apps/api/src/lib/fleet-cash-payment-service.ts")],outfile:path.join(scratch,"source-service.cjs"),platform:"node",target:"node22",format:"cjs",bundle:true,plugins:[plugin(/^\.\/db$/,"__fleetSourceQaPool")],logLevel:"silent"});
 const token=randomBytes(24).toString("hex");
 process.env.FLEET_FINANCE_COMPANY_MAP='{"1":3}';process.env.FLEET_FINANCE_SERVICE_TOKEN=token;process.env.FLEET_FINANCE_WRITE_ENABLED="true";
 process.env.CENTRAL_FINANCE_WRITE_ENABLED="true";process.env.CENTRAL_FINANCE_SERVICE_TOKEN=token;
 const app=express();app.use(express.json());app.use("/api/integrations/fleet",req(path.join(scratch,"receiver.cjs")).default);
 server=app.listen(0,"127.0.0.1");await new Promise((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject)});
 const base="http://127.0.0.1:"+server.address().port;process.env.CENTRAL_FINANCE_BASE_URL=base;
 const service=req(path.join(scratch,"source-service.cjs"));
 let lostId,lostEntry,raceId,raceEntry;
 await test("source actor is non-superuser and cannot write Finance tables",async()=>{
  const r=(await sourcePool.query("SELECT current_user role,rolsuper,rolbypassrls,has_table_privilege(current_user,'public.accounting_entries','INSERT') journal_insert FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.equal(r.rolsuper,false);assert.equal(r.rolbypassrls,false);assert.equal(r.journal_insert,false);proof.sourceRole=r;
 });
 const ownershipSnapshot=()=>row("SELECT (SELECT count(*)::int FROM public.fleet_cash_payments) payments,(SELECT count(*)::int FROM public.accounting_entries) journals,(SELECT count(*)::int FROM public.accounting_entry_lines) lines,(SELECT count(*)::int FROM public.fleet_ledger_entries) ledger,(SELECT to_jsonb(o) FROM public.fleet_outstanding o WHERE id=$1) outstanding",[lost.outstandingId]);
 await test("another driver cannot apply payment to an explicit outstanding ID",async()=>{
  const before=await ownershipSnapshot();
  await expectError(()=>service.createFleetCashPayment({...lost,driverName:"QA Another Driver "+runId,referenceNo:"QA-WRONG-NAME-"+runId}),409);
  assert.deepEqual(await ownershipSnapshot(),before);
  proof.wrongDriver={rejectedStatus:409,sourceAndFinanceWrites:0,balanceUnchanged:50000};
 });
 await test("different driver external ID cannot apply payment to an explicit outstanding ID",async()=>{
  const before=await ownershipSnapshot();
  await expectError(()=>service.createFleetCashPayment({...lost,driverExternalId:"qa-other-"+runId,referenceNo:"QA-WRONG-ID-"+runId}),409);
  assert.deepEqual(await ownershipSnapshot(),before);
  proof.wrongDriverExternalId={rejectedStatus:409,sourceAndFinanceWrites:0,balanceUnchanged:50000};
 });
 await test("lost response after Finance COMMIT preserves recoverable source and balance",async()=>{
  let intercepted=false;
  globalThis.fetch=async(url,init)=>{const response=await realFetch(url,init);if(!intercepted&&String(url)===base+"/api/integrations/fleet/cash-payments"){intercepted=true;assert.equal(response.status,201);throw new Error("QA simulated lost response after Finance commit")}return response};
  const error=await expectError(()=>service.createFleetCashPayment(lost),503);
  globalThis.fetch=realFetch;
  assert.equal(error.details.paymentRecorded,true);assert.equal(error.details.retryAvailable,true);lostId=error.details.paymentId;
  const source=await row("SELECT company_id,status,accounting_entry_id FROM public.fleet_cash_payments WHERE id=$1",[lostId]);
  assert.deepEqual(source,{company_id:1,status:"confirmed",accounting_entry_id:null});
  const entry=await row("SELECT id,company_id,status::text FROM public.accounting_entries WHERE source='fleet_cash_payment' AND source_id=$1",[lostId]);
  assert.equal(entry.company_id,3);assert.equal(entry.status,"posted");lostEntry=entry.id;
  assert.equal(Number((await row("SELECT outstanding_amount FROM public.fleet_outstanding WHERE id=$1",[lost.outstandingId])).outstanding_amount),50000);
 });
 await test("duplicate create and cancel while pending reject without extra source or reversal",async()=>{
  const createError=await expectError(()=>service.createFleetCashPayment(lost),409);assert.equal(createError.details.paymentId,lostId);
  await expectError(()=>service.cancelFleetCashPayment(1,lostId,"fleet-source-qa"),409);
  assert.equal((await row("SELECT count(*)::int n FROM public.fleet_cash_payments WHERE reference_no=$1",[lost.referenceNo])).n,1);
  assert.equal((await row("SELECT count(*)::int n FROM public.accounting_entries WHERE source='reversal' AND source_id=$1",[lostEntry])).n,0);
 });
 await test("eight concurrent retries use same payment/journal and reduce outstanding once",async()=>{
  const results=await Promise.all(Array.from({length:8},()=>service.retryFleetCashPayment(1,lostId,"fleet-source-qa")));
  assert.ok(results.every(r=>r.accountingPosted&&r.accountingEntryId===lostEntry&&r.payment.id===lostId));
  const source=await row("SELECT status,accounting_entry_id FROM public.fleet_cash_payments WHERE id=$1",[lostId]);assert.deepEqual(source,{status:"posted",accounting_entry_id:lostEntry});
  assert.equal(Number((await row("SELECT outstanding_amount FROM public.fleet_outstanding WHERE id=$1",[lost.outstandingId])).outstanding_amount),45000);
  assert.equal((await row("SELECT count(*)::int n FROM public.accounting_entries WHERE source='fleet_cash_payment' AND source_id=$1",[lostId])).n,1);
  proof.lostResponse={paymentId:lostId,entryId:lostEntry,retries:8,balanceBefore:50000,balanceAfter:45000};
 });
 await test("cancel cannot overtake create between Finance commit and local settlement",async()=>{
  let signal,release;const committed=new Promise(resolve=>signal=resolve),resume=new Promise(resolve=>release=resolve);let paused=false;
  globalThis.fetch=async(url,init)=>{const response=await realFetch(url,init);if(!paused&&String(url)===base+"/api/integrations/fleet/cash-payments"){paused=true;assert.equal(response.status,201);signal();await resume}return response};
  const creating=service.createFleetCashPayment(race);
  try{
   await timeout(committed);
   const source=await row("SELECT id,status,accounting_entry_id FROM public.fleet_cash_payments WHERE reference_no=$1",[race.referenceNo]);raceId=source.id;assert.equal(source.status,"confirmed");
   await expectError(()=>service.cancelFleetCashPayment(1,raceId,"fleet-source-qa"),409);
   assert.equal(Number((await row("SELECT outstanding_amount FROM public.fleet_outstanding WHERE id=$1",[race.outstandingId])).outstanding_amount),60000);
  }finally{release();globalThis.fetch=realFetch}
  const result=await creating;raceEntry=result.accountingEntryId;assert.equal(result.payment.status,"posted");
  assert.equal(Number((await row("SELECT outstanding_amount FROM public.fleet_outstanding WHERE id=$1",[race.outstandingId])).outstanding_amount),54000);
  proof.cancelRace={paymentId:raceId,entryId:raceEntry,cancelPendingStatus:409,balanceBefore:60000,balanceAfter:54000};
 });
 await test("eight concurrent cancels create one reversal and restore outstanding once",async()=>{
  const original=await row("SELECT to_jsonb(e) value FROM public.accounting_entries e WHERE id=$1",[raceEntry]);
  const out=await Promise.all(Array.from({length:8},()=>service.cancelFleetCashPayment(1,raceId,"fleet-source-qa")));
  assert.ok(out.every(r=>r.ok));
  assert.equal((await row("SELECT count(*)::int n FROM public.accounting_entries WHERE source='reversal' AND source_id=$1",[raceEntry])).n,1);
  assert.equal((await row("SELECT status FROM public.fleet_cash_payments WHERE id=$1",[raceId])).status,"cancelled");
  assert.equal(Number((await row("SELECT outstanding_amount FROM public.fleet_outstanding WHERE id=$1",[race.outstandingId])).outstanding_amount),60000);
  assert.deepEqual(await row("SELECT to_jsonb(e) value FROM public.accounting_entries e WHERE id=$1",[raceEntry]),original);
  await service.cancelFleetCashPayment(1,raceId,"fleet-source-qa");
  assert.equal(Number((await row("SELECT outstanding_amount FROM public.fleet_outstanding WHERE id=$1",[race.outstandingId])).outstanding_amount),60000);
  proof.parallelCancel={requests:8,reversals:1,balanceRestored:60000};
 });
 await test("wrong source company cannot retry/cancel and cancelled payment cannot retry",async()=>{
  await expectError(()=>service.retryFleetCashPayment(3,lostId,"fleet-source-qa"),404);
  await expectError(()=>service.cancelFleetCashPayment(3,lostId,"fleet-source-qa"),404);
  await expectError(()=>service.retryFleetCashPayment(1,raceId,"fleet-source-qa"),409);
 });
 await test("recovery and race journals/lines/ledger all remain Diva3",async()=>{
  const entries=(await admin.query("SELECT id,company_id,source::text,source_id FROM public.accounting_entries WHERE (source='fleet_cash_payment' AND source_id=ANY($1::int[])) OR(source='reversal' AND source_id=$2) ORDER BY id",[[lostId,raceId],raceEntry])).rows;
  assert.equal(entries.length,3);assert.ok(entries.every(e=>e.company_id===3));
  const ledger=await row("SELECT count(*)::int n,count(*) FILTER(WHERE company_id<>3)::int wrong_company FROM public.fleet_ledger_entries WHERE (source_type='fleet_cash_payment' AND source_id=ANY($1::int[])) OR(source_type='reversal' AND source_id=$2)",[[lostId,raceId],raceEntry]);
  assert.equal(ledger.n,6);assert.equal(ledger.wrong_company,0);proof.final={journals:entries,ledger};
 });
 process.stdout.write(JSON.stringify({ok:true,testsPassed:passed.length,scope:"actual source helper -> actual client -> actual HTTP receiver -> isolated PostgreSQL",proof},null,2)+"\n");
}catch(error){process.stderr.write(JSON.stringify({ok:false,testsPassed:passed.length,error:String(error?.stack||error)})+"\n");process.exitCode=1}
finally{globalThis.fetch=realFetch;if(server)await new Promise(resolve=>server.close(resolve));if(sourcePool)await sourcePool.end();await financePool.end();await admin.end();delete globalThis.__fleetFinanceQaPool;delete globalThis.__fleetSourceQaPool;if(scratch)await rm(scratch,{recursive:true,force:true})}
