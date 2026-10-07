import type { ReactNode } from "react";
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

  return (
    <div className="min-h-screen text-slate-100">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute left-[8%] top-[-9rem] h-[28rem] w-[28rem] rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="absolute right-[6%] top-[10%] h-[24rem] w-[24rem] rounded-full bg-cyan-500/8 blur-3xl" />
      </div>

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-white/[0.07] bg-slate-950/78 px-3 py-4 backdrop-blur-2xl lg:block">
        <div className="mb-7 flex items-center gap-3 px-3">
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
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.035] lg:hidden">
                <Menu className="h-4 w-4 text-slate-300" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold tracking-[-0.015em] text-slate-100">Fleet Operations Command Center</div>
                <div className="hidden text-xs text-slate-500 sm:block">Monitoring, collections, driver performance & fleet controls</div>
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-full border border-emerald-400/15 bg-emerald-400/[0.055] px-3 py-1.5 text-[11px] font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_9px_rgba(52,211,153,.8)]" />
              Production
            </div>
          </div>

          <div className="overflow-x-auto border-t border-white/[0.05] px-3 py-2 lg:hidden">
            <nav className="flex min-w-max gap-1">
              {NAV.map(({ label, href, icon: Icon }) => {
                const active = isActive(location, href);
                return (
                  <Link key={href} href={href}>
                    <span className={
                      "flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs " +
                      (active ? "bg-indigo-500/20 text-indigo-200" : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-200")
                    }>
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </header>

        <main className="fleet-page px-4 py-5 md:px-6 md:py-7 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
