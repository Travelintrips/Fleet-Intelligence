import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CircleDollarSign,
  Gauge,
  LayoutDashboard,
  Menu,
  Settings2,
  Truck,
  Users,
  WalletCards,
  MessageCircle,
  Link2,
  LogOut,
  X,
} from "lucide-react";

const NAV = [
  { label: "Dashboard", href: "/logistics/fleet-intelligence", icon: LayoutDashboard },
  { label: "Drivers", href: "/logistics/fleet-intelligence/drivers", icon: Users },
  { label: "Vehicles", href: "/logistics/fleet-intelligence/vehicles", icon: Truck },
  { label: "Transactions", href: "/logistics/fleet-intelligence/transactions", icon: WalletCards },
  { label: "Gojek Connector", href: "/logistics/fleet-intelligence/gojek-connector", icon: Link2 },
  { label: "Outstanding", href: "/logistics/fleet-intelligence/outstanding", icon: CircleDollarSign },
  { label: "Analytics", href: "/logistics/fleet-intelligence/analytics", icon: BarChart3 },
  { label: "Alerts", href: "/logistics/fleet-intelligence/alerts", icon: AlertTriangle },
  { label: "WhatsApp", href: "/logistics/fleet-intelligence/whatsapp", icon: MessageCircle },
  { label: "Accounting", href: "/logistics/fleet-intelligence/accounting", icon: Gauge },
  { label: "Control Center", href: "/logistics/fleet-intelligence/control-center", icon: Settings2 },
];

function isActive(location: string, href: string) {
  if (href === "/logistics/fleet-intelligence") return location === href;
  return location === href || location.startsWith(href + "/");
}

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useEffect(() => { setMobileMenuOpen(false); }, [location]);

  return (
    <div className="min-h-screen text-slate-100">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute left-[8%] top-[-9rem] h-[28rem] w-[28rem] rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="absolute right-[6%] top-[10%] h-[24rem] w-[24rem] rounded-full bg-cyan-500/8 blur-3xl" />
      </div>

      {mobileMenuOpen && (
        <button aria-label="Tutup menu navigasi" className="fixed inset-0 z-40 bg-black/65 lg:hidden" onClick={() => setMobileMenuOpen(false)} />
      )}
      <aside className={"fixed inset-y-0 left-0 z-50 w-[min(290px,85vw)] border-r border-white/[0.07] bg-slate-950 px-3 py-4 backdrop-blur-2xl transition-transform duration-200 lg:z-40 lg:w-[248px] lg:translate-x-0 " + (mobileMenuOpen ? "translate-x-0" : "-translate-x-full")}>
        <div className="mb-7 flex items-center gap-3 px-3">
          <button aria-label="Tutup navigasi" className="ml-auto order-last rounded-lg p-2 text-slate-300 lg:hidden" onClick={() => setMobileMenuOpen(false)}><X className="h-5 w-5" /></button>
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-indigo-400/20 bg-gradient-to-br from-indigo-500/25 to-cyan-400/10 shadow-lg shadow-indigo-950/30">
            <Activity className="h-5 w-5 text-indigo-300" />
          </div>
          <div>
            <div className="text-[15px] font-semibold tracking-[-0.02em] text-white">CST Fleet</div>
            <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">Intelligence Suite</div>
          </div>
        </div>

        <div className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">
          Workspace
        </div>
        <nav className="space-y-1">
          {NAV.map(({ label, href, icon: Icon }) => {
            const active = isActive(location, href);
            return (
              <Link key={href} href={href}>
                <span
                  className={
                    "group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all " +
                    (active
                      ? "border border-indigo-400/15 bg-gradient-to-r from-indigo-500/20 to-indigo-500/5 text-white shadow-[0_8px_26px_rgba(49,46,129,.16)]"
                      : "border border-transparent text-slate-400 hover:border-white/[0.05] hover:bg-white/[0.035] hover:text-slate-100")
                  }
                >
                  <Icon className={"h-4 w-4 " + (active ? "text-indigo-300" : "text-slate-500 group-hover:text-slate-300")} />
                  <span>{label}</span>
                  {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-indigo-300 shadow-[0_0_12px_rgba(165,180,252,.9)]" />}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="absolute bottom-4 left-3 right-3 rounded-2xl border border-white/[0.06] bg-white/[0.025] p-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-300">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.65)]" />
            Fleet Workspace
          </div>
          <div className="text-[11px] leading-relaxed text-slate-500">Production operations console</div>
        </div>
      </aside>

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#060a16]/72 backdrop-blur-2xl">
          <div className="flex min-h-16 items-center justify-between gap-4 px-4 md:px-6 lg:px-8">
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
              <button type="button" aria-label="Buka menu navigasi" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.035] lg:hidden">
                <Menu className="h-5 w-5 text-slate-300" />
              </button>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold tracking-[-0.015em] text-slate-100">Fleet Operations Command Center</div>
                <div className="hidden text-xs text-slate-500 sm:block">Monitoring, collections, driver performance & fleet controls</div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              <div className="flex items-center gap-2 rounded-full border border-emerald-400/15 bg-emerald-400/[0.055] px-2 sm:px-3 py-1.5 text-[11px] font-medium text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_9px_rgba(52,211,153,.8)]" />
                Production
              </div>
              <a
                href="/api/logout?redirect=/logistics/fleet-intelligence"
                aria-label="Keluar dari CST Fleet"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-rose-400/30 hover:bg-rose-500/10 hover:text-rose-200"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Log Out</span>
              </a>
            </div>
          </div>

        </header>

        <main className="fleet-page min-w-0 px-3 py-4 sm:px-4 sm:py-5 md:px-6 md:py-7 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
