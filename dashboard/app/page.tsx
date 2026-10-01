"use client";

import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Home as HomeIcon,
  MapPin,
  Menu,
  MessageSquare,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";

const stats = [
  {
    title: "Active Emergencies",
    value: "12",
    change: "+3 today",
    icon: ShieldAlert,
  },
  {
    title: "Resolved Incidents",
    value: "86",
    change: "+8 this week",
    icon: CheckCircle2,
  },
  {
    title: "Pending Reports",
    value: "24",
    change: "Needs attention",
    icon: Clock3,
  },
  {
    title: "Registered Users",
    value: "1,248",
    change: "+42 this month",
    icon: Users,
  },
];

const incidents = [
  {
    id: "#OK-1048",
    type: "Security Alert",
    location: "Turkana County",
    time: "5 min ago",
    status: "Active",
    priority: "High",
  },
  {
    id: "#OK-1047",
    type: "Medical Emergency",
    location: "Marsabit County",
    time: "18 min ago",
    status: "Responding",
    priority: "High",
  },
  {
    id: "#OK-1046",
    type: "Community Alert",
    location: "Samburu County",
    time: "42 min ago",
    status: "Pending",
    priority: "Medium",
  },
  {
    id: "#OK-1045",
    type: "Security Alert",
    location: "Baringo County",
    time: "1 hr ago",
    status: "Resolved",
    priority: "Low",
  },
];

const responseOverview = [
  { label: "Response Teams", value: "8 teams", detail: "3 on duty" },
  { label: "Avg. Response Time", value: "6 min", detail: "Target: 10 min" },
  { label: "Coverage", value: "5 counties", detail: "Turkana, Marsabit, Samburu, Baringo, West Pokot" },
];

const liveLocations = [
  { id: "#OK-1048", area: "Lodwar, Turkana County", priority: "High" },
  { id: "#OK-1047", area: "Marsabit Town, Marsabit County", priority: "High" },
  { id: "#OK-1046", area: "Maralal, Samburu County", priority: "Medium" },
];

const systemActivity = [
  { time: "09:42", text: "Emergency #OK-1048 created by community member" },
  { time: "09:38", text: "Responder team assigned to #OK-1047" },
  { time: "09:15", text: "Emergency #OK-1046 acknowledged" },
  { time: "08:57", text: "Emergency #OK-1045 marked resolved" },
];

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    Active: "bg-red-500/15 text-red-400 border-red-500/30",
    Responding: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    Pending: "bg-slate-500/15 text-slate-300 border-slate-500/30",
    Resolved: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        styles[status] ?? styles.Pending
      }`}
    >
      {status}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const styles: Record<string, string> = {
    High: "bg-red-500/15 text-red-400 border-red-500/30",
    Medium: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    Low: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        styles[priority] ?? styles.Low
      }`}
    >
      {priority}
    </span>
  );
}

function NavItem({
  icon: Icon,
  label,
  active = false,
  badge,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  badge?: string;
}) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
        active
          ? "bg-red-500/10 font-semibold text-red-400"
          : "text-slate-400 hover:bg-white/5 hover:text-white"
      }`}
    >
      <Icon className="h-5 w-5" />
      <span className="flex-1 text-left">{label}</span>
      {badge && (
        <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs font-semibold text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {sidebarOpen && (
        <button
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-white/10 bg-slate-900 transition-transform duration-300 lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col">
          {/* Logo */}
          <div className="flex h-20 items-center justify-between border-b border-white/10 px-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500 shadow-lg shadow-red-500/20">
                <ShieldAlert className="h-6 w-6 text-white" />
              </div>

              <div>
                <h1 className="text-lg font-bold tracking-tight">Okoa Jamii</h1>
                <p className="text-xs text-slate-400">Emergency Response</p>
              </div>
            </div>

            <button
              onClick={() => setSidebarOpen(false)}
              aria-label="Close navigation"
              className="rounded-lg p-2 text-slate-400 hover:bg-white/5 lg:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 space-y-2 overflow-y-auto p-4">
            <p className="mb-3 px-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Main Menu
            </p>

            <NavItem icon={HomeIcon} label="Dashboard" active />
            <NavItem icon={ShieldAlert} label="Emergency Alerts" badge="12" />
            <NavItem icon={MapPin} label="Live Locations" />
            <NavItem icon={Users} label="Community Users" />
            <NavItem icon={MessageSquare} label="Messages" badge="5" />

            <p className="mb-3 mt-8 px-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Management
            </p>

            <NavItem icon={Activity} label="Activity Logs" />
            <NavItem icon={Bell} label="Notifications" />
          </nav>

          {/* User */}
          <div className="border-t border-white/10 p-4">
            <div className="flex items-center gap-3 rounded-xl bg-white/5 p-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-700 font-semibold">
                AD
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">Administrator</p>
                <p className="truncate text-xs text-slate-400">System Admin</p>
              </div>

              <ChevronDown className="h-4 w-4 text-slate-500" />
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="lg:pl-72">
        {/* Header */}
        <header className="sticky top-0 z-30 border-b border-white/10 bg-slate-950/90 backdrop-blur-xl">
          <div className="flex h-20 items-center justify-between px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setSidebarOpen(true)}
                aria-label="Open navigation"
                className="rounded-xl border border-white/10 p-2 text-slate-300 hover:bg-white/5 lg:hidden"
              >
                <Menu className="h-5 w-5" />
              </button>

              <div>
                <h2 className="text-xl font-bold">Emergency Dashboard</h2>
                <p className="hidden text-sm text-slate-400 sm:block">
                  Monitor and coordinate community emergency response.
                </p>
              </div>
            </div>

            <button
              aria-label="Notifications"
              className="relative rounded-xl border border-white/10 p-3 text-slate-300 hover:bg-white/5"
            >
              <Bell className="h-5 w-5" />
              <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-red-500" />
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="p-4 sm:p-6 lg:p-8">
          {/* Welcome */}
          <section className="mb-8 rounded-2xl border border-red-500/20 bg-gradient-to-r from-red-500/10 via-slate-900 to-slate-900 p-6">
            <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center">
              <div>
                <div className="mb-2 flex items-center gap-2 text-red-400">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                  System operational
                </div>

                <h3 className="text-2xl font-bold">Welcome to Okoa Jamii</h3>
                <p className="mt-1 max-w-2xl text-sm text-slate-400">
                  Monitor emergency reports, coordinate responders, and help
                  protect communities in real time.
                </p>
              </div>

              <button className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-500 px-5 py-3 text-sm font-semibold shadow-lg shadow-red-500/20 transition hover:bg-red-400">
                <ShieldAlert className="h-4 w-4" />
                View Emergency Alerts
              </button>
            </div>
          </section>

          {/* Statistics */}
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {stats.map((stat) => {
              const Icon = stat.icon;

              return (
                <div
                  key={stat.title}
                  className="rounded-2xl border border-white/10 bg-slate-900 p-5 transition hover:border-white/20"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm text-slate-400">{stat.title}</p>
                      <p className="mt-2 text-3xl font-bold">{stat.value}</p>
                    </div>

                    <div className="rounded-xl bg-white/5 p-3">
                      <Icon className="h-5 w-5 text-slate-300" />
                    </div>
                  </div>

                  <p className="mt-4 text-xs text-slate-500">{stat.change}</p>
                </div>
              );
            })}
          </section>

          {/* Dashboard grid */}
          <section className="mt-8 grid gap-6 xl:grid-cols-3">
            {/* Incidents */}
            <div className="rounded-2xl border border-white/10 bg-slate-900 xl:col-span-2">
              <div className="flex items-center justify-between border-b border-white/10 p-5">
                <div>
                  <h3 className="font-semibold">Recent Emergency Reports</h3>
                  <p className="mt-1 text-xs text-slate-500">
                    Latest reports received by the system
                  </p>
                </div>

                <button className="text-sm font-medium text-red-400 hover:text-red-300">
                  View all
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-left text-sm">
                  <thead className="border-b border-white/10 text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-5 py-4">Incident</th>
                      <th className="px-5 py-4">Location</th>
                      <th className="px-5 py-4">Time</th>
                      <th className="px-5 py-4">Priority</th>
                      <th className="px-5 py-4">Status</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-white/5">
                    {incidents.map((incident) => (
                      <tr
                        key={incident.id}
                        className="transition hover:bg-white/[0.03]"
                      >
                        <td className="px-5 py-4">
                          <p className="font-semibold">{incident.id}</p>
                          <p className="text-xs text-slate-500">
                            {incident.type}
                          </p>
                        </td>

                        <td className="px-5 py-4 text-slate-300">
                          {incident.location}
                        </td>

                        <td className="px-5 py-4 text-slate-400">
                          {incident.time}
                        </td>

                        <td className="px-5 py-4">
                          <PriorityBadge priority={incident.priority} />
                        </td>

                        <td className="px-5 py-4">
                          <StatusBadge status={incident.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right column */}
            <div className="space-y-6">
              {/* Response overview */}
              <div className="rounded-2xl border border-white/10 bg-slate-900 p-5">
                <h3 className="font-semibold">Response Overview</h3>
                <p className="mt-1 text-xs text-slate-500">
                  Current response capacity
                </p>

                <div className="mt-4 space-y-4">
                  {responseOverview.map((item) => (
                    <div
                      key={item.label}
                      className="rounded-xl border border-white/5 bg-white/[0.03] p-4"
                    >
                      <p className="text-xs uppercase tracking-wider text-slate-500">
                        {item.label}
                      </p>
                      <p className="mt-1 text-lg font-bold">{item.value}</p>
                      <p className="mt-1 text-xs text-slate-400">{item.detail}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Live locations */}
              <div className="rounded-2xl border border-white/10 bg-slate-900 p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">Live Emergency Locations</h3>
                  <span className="flex items-center gap-1.5 text-xs text-red-400">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                    Live
                  </span>
                </div>

                <div className="mt-4 space-y-3">
                  {liveLocations.map((location) => (
                    <div
                      key={location.id}
                      className="flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.03] p-4"
                    >
                      <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />

                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold">{location.id}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-400">
                          {location.area}
                        </p>
                      </div>

                      <PriorityBadge priority={location.priority} />
                    </div>
                  ))}
                </div>
              </div>

              {/* System activity */}
              <div className="rounded-2xl border border-white/10 bg-slate-900 p-5">
                <h3 className="font-semibold">System Activity</h3>
                <p className="mt-1 text-xs text-slate-500">
                  Recent events across the platform
                </p>

                <div className="mt-4 space-y-4">
                  {systemActivity.map((event) => (
                    <div key={event.time} className="flex gap-3">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500" />
                      <div>
                        <p className="text-sm text-slate-300">{event.text}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {event.time}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
