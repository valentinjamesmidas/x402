import { useEffect, useRef, useState } from "react";
import { Activity, ArrowUpRight, Blocks, ChevronRight, CircleHelp, Fingerprint, FlaskConical, LayoutGrid, LogIn, Shield, Workflow, X, Zap } from "lucide-react";
import { Dashboard } from "./dashboard";
import { AgentRegistry, ToolManager } from "./management";
import { usePlatform } from "./platform";
import type { Platform } from "./platform";
import { Sandbox } from "./sandbox";
import { useWebMcp, WebMcp } from "./webmcp";

const pages = [
  { id: "overview", label: "Overview", mobile: "Overview", icon: LayoutGrid },
  { id: "tools", label: "MCP tools", mobile: "Tools", icon: Workflow },
  { id: "sandbox", label: "Payment sandbox", mobile: "Sandbox", icon: FlaskConical },
  { id: "agents", label: "Agent registry", mobile: "Agents", icon: Fingerprint },
  { id: "webmcp", label: "WebMCP", mobile: "WebMCP", icon: Blocks },
] as const;
type Page = typeof pages[number]["id"];
const fromHash = (): Page => pages.find((page) => `#${page.id}` === window.location.hash)?.id ?? "overview";

export function App() {
  const [page, setPage] = useState<Page>(fromHash);
  const [account, setAccount] = useState(false);
  const platform = usePlatform();
  const webMcp = useWebMcp(platform.publishedEndpoints);
  const heading = pages.find((entry) => entry.id === page)?.label ?? "Overview";
  const online = platform.connection === "realtime";
  const connected = online || Boolean(platform.edge);

  useEffect(() => {
    const sync = () => { setPage(fromHash()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  function navigate(next: Page) {
    if (next === page) return;
    location.hash = next;
    setPage(next);
    window.scrollTo(0, 0);
  }
  const navigation = () => pages.map(({ id, label, mobile, icon: Icon }) =>
    <a key={id} href={`#${id}`} aria-current={page === id ? "page" : undefined} className={page === id ? "nav-link current" : "nav-link"} onClick={(event) => { event.preventDefault(); navigate(id); }}>
      <Icon size={18} strokeWidth={1.8} /><span className="desktop-label">{label}</span><span className="mobile-label">{mobile}</span>{page === id && <span className="nav-indicator" />}
    </a>);

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <a href="#overview" className="brand" onClick={(event) => { event.preventDefault(); navigate("overview"); }}>
        <span className="brand-icon"><Zap size={20} fill="currentColor" strokeWidth={1.6} /></span>
        <span><strong>x402<span>.</span></strong><small>COMMAND CENTER</small></span>
      </a>
      <div className="workspace"><span className="workspace-icon"><Shield size={16} /></span><div><strong>Operator workspace</strong><small>{platform.live ? "Authenticated" : "Sandbox environment"}</small></div></div>
      <div className="nav-heading">WORKSPACE</div>
      <nav aria-label="Workspace navigation">{navigation()}</nav>
      <div className="sidebar-bottom">
        <a className="nav-link docs" href="/agent-manifest.txt" target="_blank" rel="noreferrer"><CircleHelp size={18} /><span>Agent manifest</span><ArrowUpRight size={14} /></a>
        <div className="network-card"><span className="network-icon"><Activity size={16} /></span><div><strong>{platform.edge?.mode === "live" && platform.live ? "Base" : "Base Sepolia"}</strong><small>{online ? "Realtime connected" : connected ? "Edge connected" : "Simulation"}</small></div><i className={connected ? "active-dot" : "paused-dot"} /></div>
      </div>
    </aside>
    <div className="workspace-main">
      <header className="topbar">
        <div className="breadcrumb"><Zap className="mobile-brand" size={18} /><span>Workspace</span><ChevronRight size={13} /><strong>{heading}</strong></div>
        <div className="header-controls">
          <span className={`environment ${platform.live ? "production" : ""}`}><i />{platform.live ? online ? "Realtime" : "Operator" : "Sandbox mode"}</span>
          <button className="avatar" title="Operator account" aria-label="Operator account" onClick={() => setAccount(true)}>{platform.session?.user.email?.slice(0, 2).toUpperCase() ?? "OP"}</button>
        </div>
      </header>
      <main id="main-content">
        {platform.problem && <div className="banner" role="status">{platform.problem}</div>}
        {page === "overview" && <Dashboard events={platform.events} live={platform.live} connected={online} openSandbox={() => navigate("sandbox")} />}
        {page === "tools" && <ToolManager platform={platform} />}
        {page === "sandbox" && <Sandbox platform={platform} />}
        {page === "agents" && <AgentRegistry platform={platform} />}
        {page === "webmcp" && <WebMcp endpoints={platform.publishedEndpoints} available={webMcp} />}
      </main>
    </div>
    <nav className="mobile-nav" aria-label="Mobile workspace navigation">{navigation()}</nav>
    {account && <AccountDialog platform={platform} close={() => setAccount(false)} />}
  </div>;
}

function AccountDialog({ platform, close }: { platform: Platform; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} onClose={close} className="panel account-dialog">
    <div className="panel-heading"><div><h2>Operator account</h2><p>Supabase authentication</p></div><button className="icon-button" aria-label="Close account" onClick={close}><X size={17} /></button></div>
    <div className="form-stack">
      {platform.session ? <>
        <p>{platform.session.user.email}</p>
        {!platform.live && <p className="amber-ink">This account has no operator role.</p>}
        <button className="secondary" onClick={() => void platform.client?.auth.signOut().then(() => close())}>Sign out</button>
      </> : platform.client ? <form className="form-stack" onSubmit={(event) => {
        event.preventDefault(); setBusy(true); setMessage("");
        void platform.client?.auth.signInWithOtp({
          email, options: { shouldCreateUser: false, emailRedirectTo: location.origin },
        }).then(({ error }) => setMessage(error ? "Could not send a sign-in link to this account." : "Check your email for the sign-in link.")).finally(() => setBusy(false));
      }}>
        <label>Email address <input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <button type="submit" className="primary" disabled={busy}><LogIn size={16} />{busy ? "Sending…" : "Send sign-in link"}</button>
        <p role="status">{message}</p>
      </form> : <p>Supabase operator access is unavailable in this workspace. The sandbox data and tools are available without a session.</p>}
    </div>
  </dialog>;
}
