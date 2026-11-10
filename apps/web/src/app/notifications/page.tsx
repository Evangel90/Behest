"use client";
import { Bell } from "lucide-react";
import { AppShell } from "@/components/chrome";
import { Notifications } from "@/components/Notifications";

export default function NotificationsPage() {
  return (
    <AppShell>
      <div className="flex flex-col gap-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-muted">
          <Bell aria-hidden className="size-4" />
          Notifications
        </span>
        <h1 className="text-[clamp(32px,5vw,56px)] font-medium leading-[0.95] tracking-[-0.04em]">Hear about your plans.</h1>
        <p className="max-w-[680px] text-lg leading-relaxed text-muted">Check-in reminders, release updates and arrivals, by email, Telegram or webhook.</p>
      </div>
      <Notifications />
    </AppShell>
  );
}
