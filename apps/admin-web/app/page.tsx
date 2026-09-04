'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_CREDIT_API_URL ?? 'http://127.0.0.1:3100';
const REDEEM_SCOPE = 'gift-cards:redeem-anonymously';

type View = 'overview' | 'gift-cards' | 'clients' | 'providers' | 'accounts';
type Overview = { totalIssued:string; totalRedeemed:string; activeCards:number; redeemedCards:number; creditAccounts:number; negativeAccounts:number; integrationClients:number; activeReservations:number; ledgerImbalanceCount:number };
type Batch = { id:string; name:string; status:string; expiresAt:string|null; createdAt:string; cardCount:number; activeCount:number; redeemedCount:number; issuedCredits:string };
type Client = { id:string; name:string; status:string; createdAt:string; keyCount:number; activeKeyCount:number };
type Account = { id:string; ownerType:string; userId:string|null; postedBalance:string; reservedBalance:string; availableBalance:string; defaultProviderId:string|null; status:string; createdAt:string; apiKeyCount:number };
type AuditEvent = { id:string; action:string; targetType:string; targetId:string|null; createdAt:string };
type GeneratedCard = { id:string; code:string; creditAmount:string };
type RedeemResult = { creditAccountId:string; credited:string; balanceAfter:string; baseUrl:string; modelsUrl:string; chatCompletionsUrl:string; apiKey:string };
type AiProvider = { id:string; name:string; adapter:string; baseUrl:string; apiKeyPrefix:string; enabled:boolean; createdAt:string; updatedAt:string };

const navItems: Array<{ id:View; label:string; mark:string }> = [
  { id:'overview', label:'Overview', mark:'01' },
  { id:'gift-cards', label:'Gift cards', mark:'02' },
  { id:'clients', label:'Integrations', mark:'03' },
  { id:'providers', label:'AI providers', mark:'04' },
  { id:'accounts', label:'Credit accounts', mark:'05' },
];

function number(value:string|number|undefined) { return new Intl.NumberFormat('en-US').format(Number(value ?? 0)); }
function shortId(value:string) { return `${value.slice(0,7)}…${value.slice(-4)}`; }
function date(value:string|null) { return value ? new Intl.DateTimeFormat('en',{ month:'short',day:'numeric',year:'numeric' }).format(new Date(value)) : 'Never'; }

export default function Home() {
  const [token,setToken] = useState('');
  const [password,setPassword] = useState('');
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(false);
  const [view,setView] = useState<View>('overview');
  const [overview,setOverview] = useState<Overview|null>(null);
  const [batches,setBatches] = useState<Batch[]>([]);
  const [clients,setClients] = useState<Client[]>([]);
  const [accounts,setAccounts] = useState<Account[]>([]);
  const [providers,setProviders] = useState<AiProvider[]>([]);
  const [audit,setAudit] = useState<AuditEvent[]>([]);
  const [batchName,setBatchName] = useState('Test cards');
  const [batchExpiry,setBatchExpiry] = useState('');
  const [selectedBatch,setSelectedBatch] = useState('');
  const [quantity,setQuantity] = useState('1');
  const [creditAmount,setCreditAmount] = useState('10000');
  const [generatedCards,setGeneratedCards] = useState<GeneratedCard[]>([]);
  const [clientName,setClientName] = useState('Local gift-card website');
  const [revealedClientKey,setRevealedClientKey] = useState('');
  const [redeemClientKey,setRedeemClientKey] = useState('');
  const [redeemCode,setRedeemCode] = useState('');
  const [redeemResult,setRedeemResult] = useState<RedeemResult|null>(null);
  const [editingProvider,setEditingProvider] = useState('');
  const [providerId,setProviderId] = useState('gangram');
  const [providerName,setProviderName] = useState('Gangram');
  const [providerBaseUrl,setProviderBaseUrl] = useState('');
  const [providerApiKey,setProviderApiKey] = useState('');
  const [providerEnabled,setProviderEnabled] = useState(true);

  // Session storage is only available after the client mounts.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setToken(sessionStorage.getItem('toking_admin_token') ?? ''); setRedeemClientKey(sessionStorage.getItem('toking_client_api_key') ?? ''); },[]);

  const adminRequest = useCallback(async <T,>(path:string,options?:RequestInit):Promise<T> => {
    const response = await fetch(`${API_URL}${path}`,{ ...options,headers:{ authorization:`Bearer ${token}`,'content-type':'application/json',...options?.headers } });
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (!response.ok) {
      if (response.status === 401) { sessionStorage.removeItem('toking_admin_token'); setToken(''); }
      throw new Error(body.error?.message ?? `Request failed (${response.status})`);
    }
    return body as T;
  },[token]);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError('');
    try {
      const [nextOverview,nextBatches,nextClients,nextAccounts,nextAudit,nextProviders] = await Promise.all([
        adminRequest<Overview>('/v1/admin/overview'), adminRequest<Batch[]>('/v1/admin/gift-card-batches'), adminRequest<Client[]>('/v1/admin/clients'), adminRequest<Account[]>('/v1/admin/credit-accounts'), adminRequest<AuditEvent[]>('/v1/admin/audit-events'), adminRequest<AiProvider[]>('/v1/admin/ai-providers'),
      ]);
      setOverview(nextOverview); setBatches(nextBatches); setClients(nextClients); setAccounts(nextAccounts); setAudit(nextAudit); setProviders(nextProviders);
      setSelectedBatch((current) => current || nextBatches[0]?.id || '');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load the dashboard'); }
    finally { setLoading(false); }
  },[adminRequest,token]);

  // Fetch dashboard state whenever authentication changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); },[refresh]);
  useEffect(() => { if (!notice) return; const timer=window.setTimeout(() => setNotice(''),3000); return () => window.clearTimeout(timer); },[notice]);
  const selectedBatchName = useMemo(() => batches.find((batch) => batch.id === selectedBatch)?.name ?? 'Select a batch',[batches,selectedBatch]);

  async function login(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response=await fetch(`${API_URL}/v1/admin/login`,{ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password}) });
      const data=await response.json() as { token:string; error?:{ message?:string } }; if (!response.ok) throw new Error(data.error?.message ?? 'Unable to sign in');
      sessionStorage.setItem('toking_admin_token',data.token); setToken(data.token); setPassword('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to sign in'); }
    finally { setBusy(false); }
  }

  async function run(action:()=>Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Something went wrong'); } finally { setBusy(false); } }
  async function createBatch(event:FormEvent<HTMLFormElement>) { event.preventDefault(); await run(async()=>{ const batch=await adminRequest<{id:string}>('/v1/admin/gift-card-batches',{method:'POST',body:JSON.stringify({name:batchName,...(batchExpiry?{expiresAt:new Date(batchExpiry).toISOString()}: {})})}); setSelectedBatch(batch.id); setNotice('Gift-card batch created'); await refresh(); }); }
  async function generateCards(event:FormEvent<HTMLFormElement>) { event.preventDefault(); if(!selectedBatch){setError('Create or select a batch first');return;} await run(async()=>{ const cards=await adminRequest<GeneratedCard[]>(`/v1/admin/gift-card-batches/${selectedBatch}/cards`,{method:'POST',body:JSON.stringify({quantity:Number(quantity),creditAmount})}); setGeneratedCards(cards); setRedeemCode(cards[0]?.code ?? ''); setNotice(`${cards.length} gift card${cards.length===1?'':'s'} generated`); await refresh(); }); }
  async function createClient(event:FormEvent<HTMLFormElement>) { event.preventDefault(); await run(async()=>{ await adminRequest('/v1/admin/clients',{method:'POST',body:JSON.stringify({name:clientName})}); setNotice('Integration created'); await refresh(); }); }
  async function createClientKey(client:Client) { await run(async()=>{ const key=await adminRequest<{rawKey:string}>(`/v1/admin/clients/${client.id}/api-keys`,{method:'POST',body:JSON.stringify({name:'Redemption key',scopes:[REDEEM_SCOPE]})}); setRevealedClientKey(key.rawKey); setRedeemClientKey(key.rawKey); sessionStorage.setItem('toking_client_api_key',key.rawKey); setNotice('Client API key created'); await refresh(); }); }
  async function redeem(event:FormEvent<HTMLFormElement>) { event.preventDefault(); await run(async()=>{ const response=await fetch(`${API_URL}/v1/client/gift-cards/redeem-anonymously`,{method:'POST',headers:{authorization:`Bearer ${redeemClientKey}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({code:redeemCode})}); const result=await response.json() as RedeemResult&{error?:{message?:string}}; if(!response.ok) throw new Error(result.error?.message ?? 'Redemption failed'); setRedeemResult(result); setNotice('Gift card redeemed successfully'); await refresh(); }); }
  function clearProviderForm() { setEditingProvider(''); setProviderId('gangram'); setProviderName('Gangram'); setProviderBaseUrl(''); setProviderApiKey(''); setProviderEnabled(true); }
  function editProvider(provider:AiProvider) { setEditingProvider(provider.id); setProviderId(provider.id); setProviderName(provider.name); setProviderBaseUrl(provider.baseUrl); setProviderApiKey(''); setProviderEnabled(provider.enabled); window.scrollTo({top:0,behavior:'smooth'}); }
  async function saveProvider(event:FormEvent<HTMLFormElement>) { event.preventDefault(); await run(async()=>{ const body={name:providerName,baseUrl:providerBaseUrl,enabled:providerEnabled,...(providerApiKey?{apiKey:providerApiKey}: {})}; if(editingProvider){ await adminRequest(`/v1/admin/ai-providers/${editingProvider}`,{method:'PATCH',body:JSON.stringify(body)}); setNotice('AI provider updated'); }else{ await adminRequest('/v1/admin/ai-providers',{method:'POST',body:JSON.stringify({id:providerId,...body,apiKey:providerApiKey})}); setNotice('AI provider created'); } clearProviderForm(); await refresh(); }); }
  async function toggleProvider(provider:AiProvider) { await run(async()=>{ await adminRequest(`/v1/admin/ai-providers/${provider.id}`,{method:'PATCH',body:JSON.stringify({enabled:!provider.enabled})}); setNotice(`${provider.name} ${provider.enabled?'disabled':'enabled'}`); await refresh(); }); }
  async function testProvider(provider:AiProvider) { await run(async()=>{ const result=await adminRequest<{modelCount:number}>(`/v1/admin/ai-providers/${provider.id}/test`,{method:'POST'}); setNotice(`${provider.name} connected · ${result.modelCount} models`); await refresh(); }); }
  async function copy(value:string,label:string) { await navigator.clipboard.writeText(value); setNotice(`${label} copied`); }

  if (!token) return (
    <main className="login-shell">
      <section className="login-story"><div className="brand-lockup"><span className="brand-glyph">T</span><span>Toking</span></div><div className="story-copy"><p className="eyebrow light">Credit operations</p><h1>One quiet place for every credit.</h1><p>Issue gift cards, follow balances, and keep the ledger exact—from first redemption to final capture.</p></div><div className="story-status"><span className="status-dot"/><span>Local credit service</span><strong>127.0.0.1:3100</strong></div></section>
      <section className="login-panel"><form className="login-card" onSubmit={login}><div className="mobile-brand"><span className="brand-glyph">T</span><span>Toking</span></div><p className="eyebrow">Administrator access</p><h2>Welcome back</h2><p className="muted">Use the V1 admin password to continue.</p><label htmlFor="admin-password">Admin password</label><input id="admin-password" type="password" value={password} onChange={(event)=>setPassword(event.target.value)} placeholder="Enter password" autoComplete="current-password" autoFocus/>{error?<p className="form-error">{error}</p>:null}<button className="primary-button full" disabled={busy||!password}>{busy?'Signing in…':'Enter dashboard'}</button><p className="login-footnote">Session expires after 8 hours.</p></form></section>
    </main>
  );

  return (
    <main className="dashboard-shell">
      <aside className="sidebar"><div className="brand-lockup compact"><span className="brand-glyph">T</span><span>Toking</span></div><p className="sidebar-label">Credit service</p><nav aria-label="Admin sections">{navItems.map((item)=><button key={item.id} className={view===item.id?'nav-button active':'nav-button'} onClick={()=>setView(item.id)}><span>{item.mark}</span>{item.label}</button>)}</nav><div className="sidebar-footer"><span className="status-dot"/><div><strong>Development</strong><small>Credit API connected</small></div></div></aside>
      <section className="workspace">
        <header className="topbar"><div><p className="eyebrow">Operations console</p><h1>{navItems.find((item)=>item.id===view)?.label}</h1></div><div className="topbar-actions"><button className="quiet-button" onClick={()=>void refresh()} disabled={loading}>{loading?'Refreshing…':'Refresh'}</button><button className="quiet-button" onClick={()=>{sessionStorage.removeItem('toking_admin_token');setToken('');}}>Sign out</button></div></header>
        {error?<div className="alert error"><span>{error}</span><button onClick={()=>setError('')}>Dismiss</button></div>:null}

        {view==='overview'?<><section className="metric-grid" aria-label="Credit service summary"><article className="metric-card emphasis"><p>Total issued</p><strong>{number(overview?.totalIssued)}</strong><span>Credits generated across all cards</span></article><article className="metric-card"><p>Redeemed</p><strong>{number(overview?.totalRedeemed)}</strong><span>{number(overview?.redeemedCards)} cards redeemed</span></article><article className="metric-card"><p>Credit accounts</p><strong>{number(overview?.creditAccounts)}</strong><span>{number(overview?.negativeAccounts)} currently negative</span></article><article className="metric-card"><p>Ledger</p><strong className={overview?.ledgerImbalanceCount?'unhealthy':'healthy'}>{overview?.ledgerImbalanceCount?'Review':'Balanced'}</strong><span>{number(overview?.activeReservations)} active reservations</span></article></section><section className="two-column dashboard-row"><article className="content-card vertical"><div><p className="eyebrow">Quick start</p><h2>Test the full gift-card flow</h2><p className="muted wide">Create a batch, generate a code, then redeem it as a third-party website would.</p></div><div className="workflow-steps"><button onClick={()=>setView('gift-cards')}><b>1</b>Create cards</button><button onClick={()=>setView('clients')}><b>2</b>Create integration key</button><button onClick={()=>setView('gift-cards')}><b>3</b>Run redemption</button></div></article><article className="content-card vertical"><div><p className="eyebrow">Recent activity</p><h2>Admin audit</h2></div><div className="activity-list">{audit.slice(0,6).map((event)=><div key={event.id}><span className="activity-mark"/><p><strong>{event.action.replaceAll('.',' ')}</strong><small>{event.targetType} · {date(event.createdAt)}</small></p></div>)}{!audit.length?<p className="empty">No admin activity yet.</p>:null}</div></article></section></>:null}

        {view==='gift-cards'?<><section className="two-column dashboard-row"><form className="content-card vertical form-card" onSubmit={createBatch}><div><p className="eyebrow">Step one</p><h2>Create a batch</h2><p className="muted">A batch groups codes for tracking and expiry.</p></div><label>Batch name<input value={batchName} onChange={(event)=>setBatchName(event.target.value)} required/></label><label>Expiry <span className="optional">optional</span><input type="datetime-local" value={batchExpiry} onChange={(event)=>setBatchExpiry(event.target.value)}/></label><button className="primary-button" disabled={busy}>Create batch</button></form><form className="content-card vertical form-card" onSubmit={generateCards}><div><p className="eyebrow">Step two</p><h2>Generate codes</h2><p className="muted">Codes start with TK and contain 16 characters. Raw codes are shown only once after generation.</p></div><label>Batch<select value={selectedBatch} onChange={(event)=>setSelectedBatch(event.target.value)} required><option value="">Select a batch</option>{batches.map((batch)=><option key={batch.id} value={batch.id}>{batch.name}</option>)}</select></label><div className="field-pair"><label>Quantity<input type="number" min="1" max="1000" value={quantity} onChange={(event)=>setQuantity(event.target.value)} required/></label><label>Credits each<input type="number" min="1" value={creditAmount} onChange={(event)=>setCreditAmount(event.target.value)} required/></label></div><button className="primary-button" disabled={busy||!selectedBatch}>Generate cards</button></form></section>
          {generatedCards.length?<section className="secret-card"><div><p className="eyebrow light">New codes · save now</p><h2>{generatedCards.length} code{generatedCards.length===1?'':'s'} for {selectedBatchName}</h2></div><button className="light-button" onClick={()=>void copy(generatedCards.map((card)=>`${card.code},${card.creditAmount}`).join('\n'),'Codes')}>Copy all</button><div className="secret-list">{generatedCards.map((card)=><button key={card.id} onClick={()=>{setRedeemCode(card.code);void copy(card.code,'Gift-card code');}}><code>{card.code}</code><span>{number(card.creditAmount)} credits</span></button>)}</div></section>:null}
          <section className="content-card vertical redeem-card"><div className="section-heading"><div><p className="eyebrow">Step three</p><h2>Test third-party redemption</h2><p className="muted">This calls the public client endpoint and returns the OpenAI-compatible credentials.</p></div><span className="pill">POST /redeem-anonymously</span></div><form className="redeem-form" onSubmit={redeem}><label>Client API key<input value={redeemClientKey} onChange={(event)=>setRedeemClientKey(event.target.value)} placeholder="tci_live_…" required/></label><label>Gift-card code<input value={redeemCode} onChange={(event)=>setRedeemCode(event.target.value)} placeholder="TK7M9X2P4R8W6Y3N5" required/></label><button className="primary-button" disabled={busy}>Redeem card</button></form>{redeemResult?<div className="credential-result"><div className="credential-summary"><p>Account created</p><strong>+{number(redeemResult.credited)} credits</strong><span>Balance {number(redeemResult.balanceAfter)}</span></div><div className="credential-fields"><label>Base URL<button onClick={()=>void copy(redeemResult.baseUrl,'Base URL')}><code>{redeemResult.baseUrl}</code><span>Copy</span></button></label><label>Models URL<button onClick={()=>void copy(redeemResult.modelsUrl,'Models URL')}><code>{redeemResult.modelsUrl}</code><span>Copy</span></button></label><label>API key <em>shown once</em><button onClick={()=>void copy(redeemResult.apiKey,'API key')}><code>{redeemResult.apiKey}</code><span>Copy</span></button></label></div></div>:null}</section>
          <section className="table-card"><div className="section-heading"><div><p className="eyebrow">Inventory</p><h2>Gift-card batches</h2></div><span className="table-count">{batches.length} total</span></div><div className="table-wrap"><table><thead><tr><th>Batch</th><th>Codes</th><th>Issued</th><th>Redeemed</th><th>Expires</th><th>Status</th></tr></thead><tbody>{batches.map((batch)=><tr key={batch.id} onClick={()=>setSelectedBatch(batch.id)} className={selectedBatch===batch.id?'selected-row':''}><td><strong>{batch.name}</strong><small>{shortId(batch.id)}</small></td><td>{number(batch.cardCount)}</td><td>{number(batch.issuedCredits)}</td><td>{number(batch.redeemedCount)}</td><td>{date(batch.expiresAt)}</td><td><span className="status-chip">{batch.status}</span></td></tr>)}</tbody></table>{!batches.length?<p className="empty table-empty">No batches yet.</p>:null}</div></section></>:null}

        {view==='clients'?<><form className="content-card inline-form" onSubmit={createClient}><div><p className="eyebrow">New integration</p><h2>Connect a gift-card website</h2><p className="muted">The generated key can redeem cards into anonymous credit accounts.</p></div><label>Integration name<input value={clientName} onChange={(event)=>setClientName(event.target.value)} required/></label><button className="primary-button" disabled={busy}>Create integration</button></form>{revealedClientKey?<section className="secret-card compact-secret"><div><p className="eyebrow light">Client key · save now</p><h2>Use this key on the third-party server</h2><code>{revealedClientKey}</code></div><button className="light-button" onClick={()=>void copy(revealedClientKey,'Client API key')}>Copy key</button></section>:null}<section className="table-card"><div className="section-heading"><div><p className="eyebrow">API clients</p><h2>Integrations</h2></div><span className="table-count">{clients.length} total</span></div><div className="table-wrap"><table><thead><tr><th>Name</th><th>Active keys</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody>{clients.map((client)=><tr key={client.id}><td><strong>{client.name}</strong><small>{shortId(client.id)}</small></td><td>{number(client.activeKeyCount)}</td><td>{date(client.createdAt)}</td><td><span className="status-chip">{client.status}</span></td><td className="align-right"><button className="row-action" onClick={()=>void createClientKey(client)} disabled={busy}>Create key</button></td></tr>)}</tbody></table>{!clients.length?<p className="empty table-empty">No integrations yet.</p>:null}</div></section></>:null}

        {view==='providers'?<><form className="content-card vertical form-card dashboard-row" onSubmit={saveProvider}><div className="section-heading"><div><p className="eyebrow">{editingProvider?'Edit provider':'New provider'}</p><h2>{editingProvider?'Update AI provider':'Connect an AI provider'}</h2><p className="muted">Credentials are encrypted and never shown again. The base URL must expose OpenAI-compatible /models and /chat/completions endpoints.</p></div>{editingProvider?<button type="button" className="quiet-button" onClick={clearProviderForm}>Cancel edit</button>:null}</div><div className="provider-form-grid"><label>Provider ID<input value={providerId} onChange={(event)=>setProviderId(event.target.value.toLowerCase())} pattern="[a-z][a-z0-9-]{1,62}" disabled={Boolean(editingProvider)} required/></label><label>Display name<input value={providerName} onChange={(event)=>setProviderName(event.target.value)} required/></label><label>OpenAI-compatible base URL<input type="url" value={providerBaseUrl} onChange={(event)=>setProviderBaseUrl(event.target.value)} placeholder="https://provider.example/v1" required/></label><label>API key {editingProvider?<span className="optional">leave blank to keep current</span>:null}<input type="password" value={providerApiKey} onChange={(event)=>setProviderApiKey(event.target.value)} autoComplete="new-password" required={!editingProvider}/></label><label className="checkbox-field"><input type="checkbox" checked={providerEnabled} onChange={(event)=>setProviderEnabled(event.target.checked)}/><span>Enabled for gateway traffic</span></label></div><button className="primary-button" disabled={busy}>{editingProvider?'Save changes':'Add provider'}</button></form><section className="table-card"><div className="section-heading"><div><p className="eyebrow">Provider registry</p><h2>AI providers</h2></div><span className="table-count">{providers.length} total</span></div><div className="table-wrap"><table><thead><tr><th>Provider</th><th>Base URL</th><th>Credential</th><th>Updated</th><th>Status</th><th></th></tr></thead><tbody>{providers.map((provider)=><tr key={provider.id}><td><strong>{provider.name}</strong><small>{provider.id}</small></td><td><code>{provider.baseUrl}</code></td><td><code>{provider.apiKeyPrefix}••••</code></td><td>{date(provider.updatedAt)}</td><td><span className="status-chip">{provider.enabled?'enabled':'disabled'}</span></td><td className="provider-actions"><button className="row-action" onClick={()=>void testProvider(provider)} disabled={busy}>Test</button><button className="row-action" onClick={()=>editProvider(provider)} disabled={busy}>Edit</button><button className="row-action" onClick={()=>void toggleProvider(provider)} disabled={busy}>{provider.enabled?'Disable':'Enable'}</button></td></tr>)}</tbody></table>{!providers.length?<p className="empty table-empty">No AI providers configured yet.</p>:null}</div></section></>:null}

        {view==='accounts'?<section className="table-card dashboard-row"><div className="section-heading"><div><p className="eyebrow">Wallet ledger</p><h2>Credit accounts</h2></div><span className="table-count">{accounts.length} total</span></div><div className="table-wrap"><table><thead><tr><th>Account</th><th>Owner</th><th>Posted</th><th>Reserved</th><th>Available</th><th>Provider</th><th>Keys</th><th>Status</th></tr></thead><tbody>{accounts.map((account)=><tr key={account.id}><td><strong>{shortId(account.id)}</strong><small>{date(account.createdAt)}</small></td><td><span className="owner-chip">{account.ownerType}</span></td><td>{number(account.postedBalance)}</td><td>{number(account.reservedBalance)}</td><td className={Number(account.availableBalance)<0?'negative':''}>{number(account.availableBalance)}</td><td>{account.defaultProviderId??<span className="muted">Default</span>}</td><td>{account.apiKeyCount}</td><td><span className="status-chip">{account.status}</span></td></tr>)}</tbody></table>{!accounts.length?<p className="empty table-empty">No credit accounts yet. Redeem a card to create one.</p>:null}</div></section>:null}
      </section>
      {notice?<div className="toast"><span>✓</span>{notice}</div>:null}
    </main>
  );
}
